# Index Lifecycle Management (ILM) Policy for Log Retention and Cold Storage Archival
# This policy automatically manages index transitions through different storage tiers
# to balance between performance (hot storage) and cost (cold storage)

# HTTP Provider for Elasticsearch API calls
terraform {
  required_providers {
    elasticsearch = {
      source  = "elastic/elasticsearch"
      version = "~> 2.0"
    }
  }
}

provider "elasticsearch" {
  endpoints = ["https://${aws_elasticsearch_domain.elk_cluster.endpoint}:9200"]
  # Username and password must be provided via environment variables
  # ES_USER and ES_PASSWORD (or use AWS IAM authentication in production)
}

# ILM Policy: Automatic log rotation and cold storage transition
# Phases: Hot -> Warm -> Cold -> Delete
resource "elasticsearch_index_lifecycle_policy" "logs_ilm_policy" {
  name = "remitmortgage-logs-retention-policy"

  policy = jsonencode({
    policy = {
      phases = {
        hot = {
          min_age = "0d"
          actions = {
            # Rollover index when it reaches 50GB or 30 days (whichever comes first)
            rollover = {
              max_primary_shard_size = "50gb"
              max_age                = "30d"
            }
            # Set replicas for high availability during hot phase
            set_priority = {
              priority = 100
            }
          }
        }
        warm = {
          min_age = "3d"
          actions = {
            # Set replicas to 0 in warm phase to reduce storage
            set_replicas = {
              number_of_replicas = 0
            }
            # Force merge to optimize storage
            forcemerge = {
              max_num_segments = 1
            }
            # Set lower priority than hot indices
            set_priority = {
              priority = 50
            }
          }
        }
        cold = {
          min_age = var.log_cold_storage_days > 0 ? "${var.log_cold_storage_days}d" : "30d"
          actions = {
            # Transition to searchable snapshot (if available) or just reduce priority
            set_priority = {
              priority = 0
            }
          }
        }
        delete = {
          min_age = "${var.log_retention_years * 365}d"
          actions = {
            # Delete indices after retention period expires
            delete = {}
          }
        }
      }
    }
  })

  depends_on = [aws_elasticsearch_domain.elk_cluster]
}

# Index Template to apply ILM policy to all new log indices
resource "elasticsearch_index_template" "logs_template" {
  name = "logs-template"

  body = jsonencode({
    index_patterns = [
      "logs-*",
      "logstash-*",
      "remitmortgage-*"
    ]
    template = {
      settings = {
        index = {
          lifecycle = {
            name      = elasticsearch_index_lifecycle_policy.logs_ilm_policy.name
            rollover_alias = "logs-write"
          }
          codec      = "best_compression"
          number_of_shards = 1
          number_of_replicas = 1
        }
      }
      mappings = {
        properties = {
          "@timestamp" = {
            type = "date"
          }
          level = {
            type = "keyword"
          }
          message = {
            type = "text"
          }
          requestId = {
            type = "keyword"
          }
          traceId = {
            type = "keyword"
          }
          spanId = {
            type = "keyword"
          }
          environment = {
            type = "keyword"
          }
          service = {
            type = "keyword"
          }
          hostname = {
            type = "keyword"
          }
          error = {
            type = "object"
            properties = {
              message = {
                type = "text"
              }
              name = {
                type = "keyword"
              }
              stack = {
                type = "text"
              }
            }
          }
        }
      }
    }
    priority = 100
  })

  depends_on = [aws_elasticsearch_domain.elk_cluster]
}

output "ilm_policy_name" {
  value       = elasticsearch_index_lifecycle_policy.logs_ilm_policy.name
  description = "Name of the ILM policy for log retention"
}

output "index_template_name" {
  value       = elasticsearch_index_template.logs_template.name
  description = "Name of the index template applying ILM policy"
}
