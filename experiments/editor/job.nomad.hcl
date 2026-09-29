variable "run_id" { type = string }
variable "source_commit" { type = string }
variable "prompt" { type = string }
variable "role" {
  type = string
  default = ""
}
variable "image" { type = string }
variable "call_allowance" { type = number }

job "xean-editor" {
  type = "batch"
  datacenters = ["lab"]
  meta {
    fleet_run_kind = "xean-editor"
    fleet_owner = "xean"
    source_commit = var.source_commit
    logical_call_allowance = "${var.call_allowance}"
  }
  constraint {
    attribute = "${node.unique.name}"
    value = "jupiter"
  }
  reschedule { attempts = 0 }
  group "experiment" {
    restart {
      attempts = 0
      mode = "fail"
    }
    volume "runs" {
      type = "host"
      source = "xean_lab_runs"
      read_only = false
    }
    task "editor" {
      driver = "docker"
      user = "1000:1000"
      kill_signal = "SIGINT"
      kill_timeout = "60s"
      config {
        image = var.image
        force_pull = false
        entrypoint = ["/runs/_yean/hard-problems-resume-20260926/runtime/bun"]
        args = var.role == "" ? [
          "--no-install", "--no-env-file",
          "/runs/_xean/${var.run_id}/source/experiments/editor/run.ts",
          "/runs/_xean/${var.run_id}/source/experiments/editor/prompts/${var.prompt}.md",
          "/runs/_xean/${var.run_id}/output",
        ] : concat([
          "--no-install", "--no-env-file",
          "/runs/_xean/${var.run_id}/source/packages/cli/src/index.ts",
        ], var.role == "edit" ? ["edit"] : ["role", var.role], [
          "/runs/_xean/${var.run_id}/input.json",
          "/runs/_xean/${var.run_id}/output/campaign.sqlite",
          "/runs/_xean/${var.run_id}/settings.json",
        ])
        readonly_rootfs = true
        cap_drop = ["ALL"]
        security_opt = ["no-new-privileges"]
        pids_limit = 512
        mount {
          type = "tmpfs"
          target = "/tmp"
          tmpfs_options { size = 134217728 }
        }
      }
      env {
        CODEX_HOME = "/local"
        NODE_EXTRA_CA_CERTS = "/usr/local/share/ca-certificates/lab-root.crt"
      }
      template {
        destination = "local/config.toml"
        change_mode = "noop"
        perms = "0644"
        data = <<EOF
model_provider = "xean_codex_lb"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "live"

[model_providers.xean_codex_lb]
name = "Xean codex-lb"
base_url = "https://codex-lb.lab/backend-api/codex"
wire_api = "responses"
env_key = "XEAN_API_KEY"
supports_websockets = true
supports_standalone_web_search = true
http_headers = { "X-Codex-LB-Required-Capability" = "usage_tag_v1" }
env_http_headers = { "X-Codex-LB-Usage-Tag" = "XEAN_CODEX_USAGE_TAG" }
EOF
      }
      volume_mount {
        volume = "runs"
        destination = "/runs"
        read_only = false
      }
      resources {
        cpu = 500
        memory = 512
        memory_max = 2048
      }
      logs {
        max_files = 2
        max_file_size = 10
      }
    }
  }
}
