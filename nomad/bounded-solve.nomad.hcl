variable "source_commit" { type = string }
variable "run_id" { type = string }
# One qualified source/dependency/Bun installation, shared by new campaigns.
variable "installation" { type = string }
# Native Codex configuration without credentials. Credentials arrive in Env.
variable "codex_configs" {
  type = map(string)
  default = { "config.toml" = "# Native Codex configuration.\n" }
}
variable "round_limit" {
  type = number
  default = 20
}
variable "resume" {
  type = bool
  default = false
}
variable "image" {
  type = string
  default = "sha256:c714d1cd66307893c444945190abdabf8e7f9b1f8edd24730a704109f6080e9b"
}
variable "offline" {
  type = bool
  default = false
}

# The bounded experiment uses the existing Xean Lab image and host volume.
# Supply XEAN_API_KEY only in the task Env of the JSON submission, never in HCL.
# Set the rendered job ID and name to xean-RUN_ID before submitting.
job "xean-bounded-template" {
  type = "batch"
  datacenters = ["lab"]
  meta {
    fleet_run_id = var.run_id
    fleet_run_kind = "xean-experiment"
    fleet_owner = "xean"
    source_repo = "local:xean"
    source_commit = var.source_commit
    installation = var.installation
    round_limit = "${var.round_limit}"
  }
  constraint {
    attribute = "${node.unique.name}"
    value = "jupiter"
  }
  reschedule { attempts = 0 }
  group "solver" {
    restart {
      attempts = 0
      mode = "fail"
    }
    volume "runs" {
      type = "host"
      source = "xean_lab_runs"
      read_only = false
    }
    task "solver" {
      driver = "docker"
      user = "1000:1000"
      kill_signal = "SIGINT"
      kill_timeout = "60s"
      config {
        image = var.image
        force_pull = false
        command = "/runs/_runtime/${var.installation}/runtime/bun"
        args = concat([
          "--config=/runs/_runtime/${var.installation}/runtime/bun-runtime.toml",
          "--no-install", "--no-env-file",
          "/runs/_runtime/${var.installation}/source/scripts/bounded-solve.ts",
          "/runs/_xean/${var.run_id}",
          "--round-limit", "${var.round_limit}",
        ], var.offline ? ["--offline"] : [], var.resume ? ["--resume"] : [])
        network_mode = "bridge"
        readonly_rootfs = true
        cap_drop = ["ALL"]
        security_opt = ["no-new-privileges"]
        pids_limit = 1024
        mount {
          type = "tmpfs"
          target = "/tmp"
          tmpfs_options {
            size = 268435456
            mode = 1023
          }
        }
      }
      dynamic "template" {
        for_each = var.codex_configs
        content {
          data = template.value
          destination = "local/${template.key}"
          perms = "0600"
          uid = 1000
          gid = 1000
          change_mode = "noop"
        }
      }
      env {
        TMPDIR = "/tmp"
        HOME = "/tmp"
        CODEX_HOME = "/local"
        BUN_INSTALL_CACHE_DIR = "/tmp/bun-cache"
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
