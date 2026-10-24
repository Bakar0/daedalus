import sys
T=sys.argv[1]; base=open(T+'/pod.yaml').read()
cases={
 'session-mounts-state': base.replace("        - { name: workspace, mountPath: /workspace }","        - { name: workspace, mountPath: /workspace }\n        - { name: state, mountPath: /state }"),
 'session-mounts-token': base.replace("        - { name: workspace, mountPath: /workspace }","        - { name: workspace, mountPath: /workspace }\n        - { name: token, mountPath: /tok }"),
 'hostpath': base.replace("    - { name: cache, emptyDir: { sizeLimit: 2Gi } }","    - { name: cache, hostPath: { path: / } }"),
 'other-image': base.replace("image: daedalus-runner:dev","image: evil:1",1),
 'privileged': base.replace("runAsUser: 1000,","privileged: true, runAsUser: 1000,"),
 'hostpid': base.replace("  shareProcessNamespace: false","  hostPID: true"),
 'third-container': base.replace("  volumes:","    - {name: x, image: daedalus-runner:dev}\n  volumes:"),
 'other-pvc': base.replace("claimName: ws-abc }","claimName: ws-victim }",1),
 'no-runtime-class': base.replace("  runtimeClassName: gvisor\n",""),
 'gvisor-flag': base.replace("    dev.gvisor.spec.mount.shared.share: pod","    dev.gvisor.spec.mount.shared.share: pod\n    dev.gvisor.flag.network: host"),
 'gvisor-hint-changed': base.replace("shared.type: tmpfs","shared.type: bind"),
 'sa-token': base.replace("automountServiceAccountToken: false","automountServiceAccountToken: true"),
}
for k,v in cases.items():
  assert v != base, f"case {k} does not change pod.yaml"
  open(f"{T}/neg-{k}.yaml","w").write(v)
