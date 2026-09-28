variable "source_commit" { type = string }
variable "run_id" { type = string }
variable "image" { type = string }

# Source and protocol files are frozen separately; inject XEAN_API_KEY only
# into the Nomad JSON task environment, never into this file or run artifacts.
job "xean-editor-large-smoke-template" {
  type = "batch"
  datacenters = ["lab"]
  meta {
    fleet_run_id = var.run_id
    fleet_run_kind = "xean-editor-large-smoke"
    fleet_owner = "xean"
    source_repo = "xean"
    source_commit = var.source_commit
    logical_call_allowance = "24"
  }
  constraint {
    attribute = "${node.unique.name}"
    value = "jupiter"
  }
  reschedule { attempts = 0 }
  group "smoke" {
    restart {
      attempts = 0
      mode = "fail"
    }
    volume "runs" {
      type = "host"
      source = "xean_lab_runs"
      read_only = false
    }
    task "smoke" {
      driver = "docker"
      user = "1000:1000"
      kill_signal = "SIGINT"
      kill_timeout = "60s"
      config {
        image = var.image
        force_pull = false
        entrypoint = ["/runs/_xean/${var.run_id}/runtime/bun"]
        args = [
          "--no-install", "--no-env-file",
          "/runs/_xean/${var.run_id}/source/scripts/editor-large-smoke.ts",
          "/runs/_xean/${var.run_id}/source",
          "/runs/_xean/${var.run_id}",
        ]
        network_mode = "bridge"
        readonly_rootfs = true
        cap_drop = ["ALL"]
        security_opt = ["no-new-privileges"]
        pids_limit = 1024
        mount {
          type = "tmpfs"
          target = "/scratch"
          tmpfs_options {
            size = 268435456
            mode = 1023
          }
        }
        mount {
          type = "tmpfs"
          target = "/tmp"
          tmpfs_options {
            size = 134217728
            mode = 1023
          }
        }
      }
      env {
        TMPDIR = "/scratch"
        HOME = "/scratch"
        CODEX_HOME = "/scratch/codex"
        NODE_EXTRA_CA_CERTS = "/usr/local/share/ca-certificates/lab-root.crt"
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
        max_files = 4
        max_file_size = 20
      }
    }
  }
}
