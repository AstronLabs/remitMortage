# Remote state with locking for the multi-region root module. The state key is
# overridden per run (terraform init -backend-config="key=...") by the drift
# workflow; this default keeps it separate from the devops/ root module.
terraform {
  backend "s3" {
    bucket         = "remit-mortgage-terraform-state"
    key            = "devops/multi-region/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "remit-mortgage-terraform-locks"
    encrypt        = true
  }
}
