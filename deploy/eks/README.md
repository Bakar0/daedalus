# Daedalus cloud gateway on Amazon EKS

> **Private tests only.** Sign-in is the dev login until OIDC lands (1b).
> `POST /v1/dev/login` gives a token for any email to anyone who can reach the
> gateway, and that token can create workspaces, run code in them and read
> what is there. This guide keeps the load balancer closed to your own
> address (`inbound-cidrs`). Do not open it wider, do not put real secrets or
> customer code in a workspace, and tear the cluster down when you are done.

This sets up one EKS cluster with the Helm chart in `deploy/helm/daedalus`:

- A small on-demand node group `system` for the gateway and the cluster
  add-ons.
- A spot node group `workspaces` where each node installs a pinned,
  checksum-verified gVisor at boot and registers `runsc` with containerd. A
  taint keeps everything but workspace pods off it.
- The VPC CNI with NetworkPolicy enforcement on, the EBS CSI driver with a gp3
  StorageClass, and the EKS Pod Identity agent.
- The AWS Load Balancer Controller and an internet-facing ALB with an ACM
  certificate in front of the gateway's public port.
- Both images in ECR.

All nodes are Graviton (arm64), so images built on an Apple silicon Mac run
as they are. Everything is in one region and the nodes in one Availability
Zone (see [Known gaps](#known-gaps)).

| File                | What it is                                                               |
| ------------------- | ------------------------------------------------------------------------ |
| `cluster.yaml`      | eksctl ClusterConfig: VPC, add-ons, both node groups, the gVisor install |
| `storageclass.yaml` | StorageClass `gp3`                                                       |
| `ingress.yaml`      | The ALB Ingress                                                          |
| `values.yaml`       | Chart values for this cluster                                            |

Every command below was checked against the AWS, eksctl and gVisor
documentation listed under [Sources](#sources) on 2026-10-24. None of it has
been run against AWS yet.

## How workspaces find the gVisor nodes

The chart creates `RuntimeClass gvisor` with handler `runsc`, and the gateway
puts `runtimeClassName: gvisor` on every workspace pod. `values.yaml` sets
`workspace.runtimeClassScheduling`, which the chart writes into the
RuntimeClass's `scheduling` field. Kubernetes' RuntimeClass admission adds that
`nodeSelector` (`daedalus.dev/gvisor: "true"`) and toleration
(`daedalus.dev/workspaces=true:NoSchedule`) to each workspace pod [K8s-RC], so
workspaces run only on the `workspaces` node group. The gateway and the add-on
Deployments have no toleration, so they stay on `system`.

The gVisor install is two parts of the `workspaces` node group in
`cluster.yaml`:

- `preBootstrapCommands` downloads
  `gvisor/releases/release/20261012.0/<arch>/gvisor.tar.bz2`, checks it against
  a pinned sha512 (the same release and sums as `deploy/kind/gvisor.sh`, and
  equal to the `.sha512` files gVisor publishes), and installs `runsc`,
  `containerd-shim-runsc-v1` and `gvisor-bin/` into `/usr/local/bin`
  [gVisor-install]. On AL2023, user data scripts run after nodeadm's config
  phase and before its run phase starts containerd and kubelet [EKS-AL2023].
- `overrideBootstrapCommand` holds a nodeadm `NodeConfig`. On AL2023 managed
  node groups eksctl adds it to the user data as its own part [eksctl-AL2023],
  and nodeadm merges `spec.containerd.config` into
  `/etc/containerd/config.toml` [nodeadm-api]. The TOML adds the `runsc`
  runtime (`runtime_type = "io.containerd.runsc.v1"` [gVisor-containerd]) and
  `pod_annotations = ["dev.gvisor.*"]`, which the gateway's mount hints need.
  It is written in containerd config version 2 form: nodeadm uses it as is on
  containerd 1.7 and runs `containerd config migrate` on containerd 2
  [nodeadm-src].

## Before you start

- An AWS account where you may create VPCs, EKS clusters, IAM roles and
  policies, ECR repositories, load balancers and ACM certificates.
- A DNS name you control for the gateway, such as `daedalus.example.com`.
- On the Mac: `eksctl` 0.231.0 or later, AWS CLI v2, `kubectl`, `helm` 3,
  and Docker with `buildx`.

Use a kubeconfig of its own for this cluster so no command can reach another
cluster through an existing context:

```sh
export KUBECONFIG="$HOME/.kube/daedalus-eks"
export AWS_REGION=us-east-1
export ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export HOST=daedalus.example.com          # the gateway's DNS name
export MYIP="$(curl -s https://checkip.amazonaws.com)/32"
```

Keep these set in every terminal you use for the steps below.

## 1. Certificate

Request a certificate for `$HOST` and add the CNAME record ACM gives you to
your DNS zone:

```sh
CERT_ARN="$(aws acm request-certificate --domain-name "$HOST" \
  --validation-method DNS --query CertificateArn --output text)"
aws acm describe-certificate --certificate-arn "$CERT_ARN" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
# add that CNAME record, then:
aws acm wait certificate-validated --certificate-arn "$CERT_ARN"
```

## 2. Cluster

Edit the lines marked `EDIT` in `cluster.yaml`: the region, the two cluster
zones, the node groups' zone, and `publicAccessCIDRs` (put `$MYIP` there).
Then:

```sh
eksctl create cluster -f deploy/eks/cluster.yaml --kubeconfig "$KUBECONFIG"
```

This takes about 20 minutes. Check the result before going on:

```sh
# Both node groups, with their labels and the taint on workspaces.
kubectl get nodes -L daedalus.dev/pool,daedalus.dev/gvisor
kubectl get nodes -l daedalus.dev/gvisor=true -o jsonpath='{.items[*].spec.taints}'

# runsc is offered (filled in on nodes with containerd 2).
kubectl get nodes -l daedalus.dev/gvisor=true \
  -o jsonpath='{range .items[*]}{.metadata.name}: {.status.runtimeHandlers[*].name}{"\n"}{end}'

# The network policy agent is on: aws-node pods show 2/2 and the agent runs
# with --enable-network-policy=true.
kubectl -n kube-system get pods -l k8s-app=aws-node
kubectl -n kube-system get ds aws-node -o yaml | grep -- --enable-network-policy
```

Expect `runsc` in the handler list. If the list is empty, the node runs
containerd 1.7 and the chart cannot check it at install; the gVisor check in
[Verify](#verify) still tells you. If `--enable-network-policy=false`, stop:
every NetworkPolicy would be ignored [EKS-NP-config].

## 3. Storage

```sh
kubectl apply -f deploy/eks/storageclass.yaml
```

The EBS CSI driver add-on got its IAM role through Pod Identity when the
cluster was created (`useDefaultPodIdentityAssociations`) [eksctl-podid]. Its
node DaemonSet tolerates every taint, so it runs on the workspace nodes too.

## 4. AWS Load Balancer Controller

Version 3.6.1 (chart and controller versions match from 3.0 on). It gets its
IAM permissions through a Pod Identity association on its service account
[eksctl-podid] [LBC-helm]:

```sh
curl -fsSLo /tmp/lbc-iam-policy.json \
  https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v3.6.1/docs/install/iam_policy.json
aws iam create-policy --policy-name DaedalusLoadBalancerController \
  --policy-document file:///tmp/lbc-iam-policy.json

eksctl create podidentityassociation --cluster daedalus --region "$AWS_REGION" \
  --namespace kube-system --service-account-name aws-load-balancer-controller \
  --permission-policy-arns "arn:aws:iam::$ACCOUNT:policy/DaedalusLoadBalancerController"

VPC_ID="$(aws eks describe-cluster --name daedalus \
  --query cluster.resourcesVpcConfig.vpcId --output text)"
helm repo add eks https://aws.github.io/eks-charts
helm repo update eks
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --namespace kube-system --version 3.6.1 \
  --set clusterName=daedalus \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region="$AWS_REGION" --set vpcId="$VPC_ID"
kubectl -n kube-system rollout status deploy/aws-load-balancer-controller
```

`region` and `vpcId` are set so the controller does not need the instance
metadata service. Gateway API CRDs are not needed; this guide uses an
Ingress.

## 5. Images

From the repository root, on the commit you want to run:

```sh
REG="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
TAG="$(git rev-parse --short HEAD)"
for repo in daedalus-gateway daedalus-runner; do
  aws ecr create-repository --repository-name "$repo" \
    --image-tag-mutability IMMUTABLE \
    --image-scanning-configuration scanOnPush=true
done
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REG"
docker buildx build --platform linux/arm64 -f apps/gateway/Dockerfile \
  -t "$REG/daedalus-gateway:$TAG" --push .
docker buildx build --platform linux/arm64 -f apps/runner/Dockerfile \
  -t "$REG/daedalus-runner:$TAG" --push .
```

Tags are immutable, so a new build needs a new commit (or tag). The node role
eksctl creates can pull from ECR in the same account.

## 6. Gateway

```sh
kubectl create namespace daedalus
kubectl label namespace daedalus pod-security.kubernetes.io/enforce=restricted

# Admin page token, kept only in the cluster.
kubectl -n daedalus create secret generic daedalus-admin \
  --from-literal=admin-token="$(openssl rand -base64 32)"

helm install daedalus deploy/helm/daedalus --namespace daedalus \
  -f deploy/eks/values.yaml \
  --set image.gateway.repository="$REG/daedalus-gateway" --set image.gateway.tag="$TAG" \
  --set image.runner.repository="$REG/daedalus-runner" --set image.runner.tag="$TAG" \
  --set gateway.publicUrl="https://$HOST"
kubectl -n daedalus rollout status deploy/daedalus-gateway
```

What `values.yaml` sets, and why:

| Value                                                    | Setting                      | Reason                                                                            |
| -------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `gateway.devLogin`                                       | `true`                       | The only sign-in until 1b; see the warning at the top                             |
| `gateway.publicUrl`                                      | `https://$HOST`              | How Macs reach the gateway; must be https                                         |
| `gateway.storage.storageClass`, `workspace.storageClass` | `gp3`                        | The StorageClass from step 3                                                      |
| `workspace.runtimeClassScheduling`                       | node selector and toleration | Workspaces run on the gVisor nodes only                                           |
| `tenant.blockedEgressCIDRs`                              | chart default                | Covers the VPC (192.168.0.0/16), EKS service ranges and 169.254.0.0/16            |
| `tenant.quota`, `gateway.limits.workspacesPerUser`       | chart default (5)            | One `workspaces` node holds three awake workspaces; scale the node group for more |
| `admin.enabled`, `admin.bootstrap.existingSecret`        | `true`, `daedalus-admin`     | The admin page on 127.0.0.1 in the pod, reached by port-forward                   |

The install fails with a message if the nodes report their runtime handlers
and none offers `runsc`. That means the `workspaces` node did not get gVisor;
see [If gVisor is missing](#if-gvisor-is-missing).

## 7. Load balancer and DNS

Edit `ingress.yaml`: `certificate-arn` (`$CERT_ARN`), `inbound-cidrs`
(`$MYIP`) and `host` (`$HOST`). Then:

```sh
kubectl apply -f deploy/eks/ingress.yaml
kubectl -n daedalus get ingress daedalus-gateway \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

Point `$HOST` at that name (a CNAME, or a Route 53 alias record). Then:

```sh
curl -fsS "https://$HOST/health"
```

The ALB listens on 443 only, with TLS 1.3 policy
`ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09` [ALB-TLS]. ALBs carry WebSockets
natively over HTTPS listeners [ALB-listeners]; the idle timeout is 3600 s
(the range is 1 to 4000) [ALB-attrs], so a quiet link to a workspace stays
open. `target-type: ip` sends traffic straight to the gateway pod, which the
chart's gateway NetworkPolicy allows on the public port.

## 8. Connect the Mac

In the dev app, open Settings > Cloud, set the gateway URL to `https://$HOST`,
sign in with your email, and move a workspace to the cloud from its header.

## Verify

Find the workspace pod first:

```sh
kubectl get pods -A -o wide | grep ' ws-'
NS=u-...            # the namespace from that line
POD=ws-...          # the pod name
```

The pod should be on a `workspaces` node.

### NetworkPolicy is enforced

```sh
# Instance metadata: must time out.
kubectl -n "$NS" exec "$POD" -c session -- curl -sS -m 5 http://169.254.169.254/latest/meta-data/
# A node's kubelet: must time out.
NODE_IP="$(kubectl get nodes -l daedalus.dev/pool=system -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
kubectl -n "$NS" exec "$POD" -c session -- curl -sSk -m 5 "https://$NODE_IP:10250/healthz"
# The gateway's public port from inside the cluster: must time out (only
# the runner port is allowed).
GW_IP="$(kubectl -n daedalus get pod -l app.kubernetes.io/component=gateway -o jsonpath='{.items[0].status.podIP}')"
kubectl -n "$NS" exec "$POD" -c session -- curl -sS -m 5 "http://$GW_IP:8080/health"
# The internet: must work.
kubectl -n "$NS" exec "$POD" -c session -- curl -sS -m 10 -o /dev/null -w '%{http_code}\n' https://example.com
# The policy reached the agent.
kubectl get policyendpoints -A
```

Each of the first three must end in a timeout. A reply from 169.254.169.254
means the policy is not enforced: stop and delete the workspace. The node
group's `disablePodIMDS` would still refuse metadata at the hop limit, but the
other ranges would be open.

Run the metadata check again after the workspace has slept and woken, since
that is a new pod (see [Known gaps](#known-gaps) for why).

### gVisor is active

```sh
kubectl -n "$NS" exec "$POD" -c session -- dmesg
kubectl -n "$NS" exec "$POD" -c session -- uname -r
kubectl -n "$NS" get pod "$POD" -o jsonpath='{.spec.runtimeClassName} {.spec.nodeSelector} {.spec.tolerations}{"\n"}'
```

`dmesg` prints gVisor's own boot lines (`Starting gVisor...` through
`Ready!`) instead of the host kernel's [gVisor-docker], and `uname -r` shows gVisor's emulated kernel
version, not the AL2023 kernel (6.x). The last line shows `gvisor` and the
node selector and toleration the RuntimeClass added.

### Admin page

```sh
kubectl -n daedalus get secret daedalus-admin -o jsonpath='{.data.admin-token}' | base64 -d | pbcopy
kubectl -n daedalus port-forward deploy/daedalus-gateway 8082
open http://localhost:8082/admin/
```

Paste the token to sign in. The workspace should be listed with its status,
disk and pod resources.

### If gVisor is missing

The workspace pod stays in `ContainerCreating` with an event naming the
`runsc` handler, or the chart install fails. Look at the node's boot output:

```sh
INSTANCE="$(kubectl get nodes -l daedalus.dev/gvisor=true -o jsonpath='{.items[0].spec.providerID}' | cut -d/ -f5)"
aws ec2 get-console-output --instance-id "$INSTANCE" --latest --output text | grep -i gvisor
```

`gvisor 20261012.0 installed` means the binaries are there and the problem
is the containerd config. A checksum failure means the download changed;
replace the node (`eksctl delete nodegroup` and create it again) rather than
editing the sum.

## Costs

List prices in us-east-1 on 2026-10-24, 730 hours a month. Spot prices move;
check the AWS pricing pages or calculator before relying on them.

Fixed, whether or not any workspace exists:

| Item                                                        | Price          | Per month                          |
| ----------------------------------------------------------- | -------------- | ---------------------------------- |
| EKS control plane (standard support)                        | $0.10/h        | $73.00                             |
| `system` node, t4g.large on-demand                          | $0.0672/h      | $49.06                             |
| `workspaces` node, m7g.xlarge spot (on-demand $0.1632/h)    | about $0.093/h | about $67.89                       |
| Node root volumes, 40 + 80 GB gp3                           | $0.08/GB-month | $9.60                              |
| NAT gateway (plus $0.045 per GB processed)                  | $0.045/h       | $32.85                             |
| ALB (plus $0.008 per LCU-hour, about 1 LCU at test traffic) | $0.0225/h      | $16.43 + about $5.84               |
| Public IPv4: NAT gateway and two ALB addresses              | $0.005/h each  | $10.95                             |
| Gateway database volume, 1 GiB gp3                          |                | $0.08                              |
| **Total**                                                   |                | **about $266 (about $8.75 a day)** |

Per workspace, on top of that:

| State  | What costs money                                 | Price                                                  |
| ------ | ------------------------------------------------ | ------------------------------------------------------ |
| Asleep | Its two EBS volumes, 20 GiB + 1 GiB gp3          | $1.68 a month                                          |
| Awake  | The volumes, plus a third of a `workspaces` node | about $0.031 an hour on spot (about $0.74 a day awake) |

The first `workspaces` node is in the fixed cost, so up to three awake
workspaces cost only their volumes. Each further node is about $0.093 an hour
on spot. A workspace asleep 30 days is deleted by the gateway with its
volumes. Downloads from a workspace go through the NAT gateway at $0.045 per
GB.

## Teardown

In this order, so nothing is left behind that blocks the VPC from being
deleted or keeps billing:

```sh
# 1. The Ingress first, so the controller deletes the ALB and its target group.
kubectl -n daedalus delete ingress daedalus-gateway
kubectl get ingress -A                      # wait until none is left

# 2. Workspace namespaces: pods, Secrets and their EBS volumes.
kubectl delete ns -l daedalus.dev/user --wait

# 3. The gateway; its database volume is kept by design, so delete it too.
helm -n daedalus uninstall daedalus
kubectl -n daedalus delete pvc daedalus-gateway-data
kubectl delete ns daedalus
helm -n kube-system uninstall aws-load-balancer-controller

# 4. The cluster, node groups, VPC, NAT gateway, add-on roles.
eksctl delete cluster -f deploy/eks/cluster.yaml --wait

# 5. What eksctl did not create.
aws iam delete-policy --policy-arn "arn:aws:iam::$ACCOUNT:policy/DaedalusLoadBalancerController"
aws ecr delete-repository --repository-name daedalus-gateway --force
aws ecr delete-repository --repository-name daedalus-runner --force
aws acm delete-certificate --certificate-arn "$CERT_ARN"   # and the DNS records
rm -f "$KUBECONFIG"
```

Then check that nothing is left:

```sh
aws ec2 describe-volumes --filters Name=tag:daedalus.dev/cluster,Values=daedalus \
  --query 'Volumes[].[VolumeId,State]' --output text
aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName' --output text
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?starts_with(StackName,'eksctl-daedalus')].StackName" --output text
```

Delete any volume listed as `available` with `aws ec2 delete-volume`, and any
stack listed with `aws cloudformation delete-stack`.

## Known gaps

- **NetworkPolicy on bare pods.** The AWS docs say enforcement "might not work
  reliably" for pods without `metadata.ownerReferences` [EKS-NP], and the
  gateway creates workspace pods without an owner. That is why the checks
  above run on a real workspace pod and again after a wake, and why the node
  group also sets `disablePodIMDS`. Giving workspace pods an owner reference
  (or enforcing in strict mode, which needs policies for every pod in the
  cluster) is a gateway change for before 1b.
- **One zone, fixed size.** Both node groups are in one zone so a woken
  workspace always has a node next to its volumes. There is no Cluster
  Autoscaler or Karpenter; scale `workspaces` by hand
  (`eksctl scale nodegroup --cluster daedalus --name workspaces --nodes 2`).
  A fourth awake workspace on one node stays `Pending` until you do.
- **Spot interruptions.** EKS drains a spot node when AWS reclaims it. The
  workspace pod goes; the gateway reports "The workspace pod is gone; wake
  the workspace to start it again". Waking starts a new pod with the same
  volumes, so files under `/workspace` are kept and running sessions are not.
- **gVisor install failure is quiet.** If the boot script fails, the node
  still joins with `runsc` configured but missing, and workspace pods on it
  fail to start. The chart's install check does not catch this; the gVisor
  check above does.
- Everything in the [EKS checklist](../README.md#eks-checklist-before-1b) in
  `deploy/README.md` still applies. This guide covers network policy, private
  node subnets, IMDSv2 with hop limit 1, the VPC range in
  `blockedEgressCIDRs`, `publicAccessCIDRs` and the namespace label. Open:
  DNS to kube-dns is allowed from workspaces, the pod admission policy
  matches images by tag rather than digest, and IPv6 is not covered (the
  cluster is IPv4 only).

## Sources

- [eksctl-schema] eksctl ClusterConfig schema, https://github.com/eksctl-io/eksctl/blob/main/pkg/apis/eksctl.io/v1alpha5/assets/schema.json (`cluster.yaml` validates against it with no errors)
- [eksctl-AL2023] eksctl AL2023 bootstrap, https://github.com/eksctl-io/eksctl/blob/main/pkg/nodebootstrap/al2023.go and validation.go; https://docs.aws.amazon.com/eks/latest/eksctl/custom-ami-support.html
- [eksctl-addons] https://docs.aws.amazon.com/eks/latest/eksctl/addons.html
- [eksctl-podid] https://docs.aws.amazon.com/eks/latest/eksctl/pod-identity-associations.html
- [EKS-AL2023] https://docs.aws.amazon.com/eks/latest/userguide/al2023.html
- [nodeadm-api] https://awslabs.github.io/amazon-eks-ami/nodeadm/doc/api/ and https://awslabs.github.io/amazon-eks-ami/nodeadm/doc/examples/
- [nodeadm-src] https://github.com/awslabs/amazon-eks-ami/blob/main/nodeadm/internal/containerd/config.go
- [EKS-versions] https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html
- [EKS-NP-config] https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html
- [EKS-NP] https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html
- [EBS-CSI] https://github.com/kubernetes-sigs/aws-ebs-csi-driver/blob/master/docs/parameters.md and docs/tagging.md
- [LBC-helm] https://docs.aws.amazon.com/eks/latest/userguide/lbc-helm.html; release notes https://github.com/kubernetes-sigs/aws-load-balancer-controller/releases (v3.0.0, v3.6.1)
- [LBC-annotations] https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/
- [ALB-listeners] https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html
- [ALB-attrs] https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html
- [ALB-TLS] https://docs.aws.amazon.com/elasticloadbalancing/latest/application/describe-ssl-policies.html
- [gVisor-install] https://gvisor.dev/docs/user_guide/install/
- [gVisor-containerd] https://gvisor.dev/docs/user_guide/containerd/quick_start/
- [gVisor-docker] https://gvisor.dev/docs/user_guide/quick_start/docker/
- [K8s-RC] https://kubernetes.io/docs/concepts/containers/runtime-class/#scheduling
- Prices: https://aws.amazon.com/eks/pricing/, https://aws.amazon.com/ebs/pricing/, https://aws.amazon.com/vpc/pricing/, https://aws.amazon.com/elasticloadbalancing/pricing/, https://instances.vantage.sh/aws/ec2/m7g.xlarge, https://instances.vantage.sh/aws/ec2/t4g.large
