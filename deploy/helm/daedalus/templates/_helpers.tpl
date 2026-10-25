{{- define "daedalus.gatewayName" -}}
{{- printf "%s-gateway" (.Release.Name | trunc 50 | trimSuffix "-") -}}
{{- end -}}

{{- define "daedalus.labels" -}}
app.kubernetes.io/name: daedalus
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "daedalus.selector" -}}
app.kubernetes.io/name: daedalus
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: gateway
{{- end -}}

{{- define "daedalus.runnerServiceName" -}}
{{- printf "%s-runners" (include "daedalus.gatewayName" .) -}}
{{- end -}}

{{/* The runner listener, as runner pods reach it. Never exposed outside. */}}
{{- define "daedalus.internalUrl" -}}
{{- printf "http://%s.%s.svc:%v" (include "daedalus.runnerServiceName" .) .Release.Namespace .Values.gateway.service.runnerPort -}}
{{- end -}}
