# ------------------------------------------------------------------------------
# AWS Cost Anomaly Detection & Slack Alerting Infrastructure
# ------------------------------------------------------------------------------

# 1. Dimensional Service-Level Cost Anomaly Monitor
resource "aws_ce_anomaly_monitor" "service_monitor" {
  name              = "remit-mortgage-service-cost-anomaly-monitor-${var.environment}"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"

  tags = {
    Name        = "remit-mortgage-service-anomaly-monitor-${var.environment}"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Project     = "RemitMortgage"
  }
}

# 2. Custom Tag-Level Cost Anomaly Monitor (filtering by Environment)
resource "aws_ce_anomaly_monitor" "environment_tag_monitor" {
  name         = "remit-mortgage-tag-cost-anomaly-monitor-${var.environment}"
  monitor_type = "CUSTOM"
  monitor_specification = jsonencode({
    Tags = {
      Key    = "Environment"
      Values = [var.environment]
    }
  })

  tags = {
    Name        = "remit-mortgage-tag-anomaly-monitor-${var.environment}"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Project     = "RemitMortgage"
  }
}

# 3. SNS Topic for Cost Anomaly Notifications
resource "aws_sns_topic" "cost_anomaly_alerts" {
  name = "remit-mortgage-cost-anomaly-alerts-${var.environment}"

  tags = {
    Name        = "remit-mortgage-cost-anomaly-alerts-${var.environment}"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Project     = "RemitMortgage"
  }
}

# 4. SNS Topic Policy Allowing AWS Cost Explorer (costalerts.amazonaws.com) to Publish
resource "aws_sns_topic_policy" "cost_anomaly_policy" {
  arn = aws_sns_topic.cost_anomaly_alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AWSAnomalyDetectionSNSPublish"
        Effect = "Allow"
        Principal = {
          Service = "costalerts.amazonaws.com"
        }
        Action   = "SNS:Publish"
        Resource = aws_sns_topic.cost_anomaly_alerts.arn
      }
    ]
  })
}

# 5. Cost Anomaly Subscription linking Monitors to SNS with Impact Threshold
resource "aws_ce_anomaly_subscription" "cost_anomaly_subscription" {
  name      = "remit-mortgage-cost-anomaly-subscription-${var.environment}"
  frequency = var.cost_anomaly_eval_frequency

  monitor_arn_list = [
    aws_ce_anomaly_monitor.service_monitor.arn,
    aws_ce_anomaly_monitor.environment_tag_monitor.arn
  ]

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.cost_anomaly_alerts.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      values        = [tostring(var.cost_anomaly_threshold_amount)]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }

  tags = {
    Name        = "remit-mortgage-cost-anomaly-subscription-${var.environment}"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Project     = "RemitMortgage"
  }
}

# ------------------------------------------------------------------------------
# Slack Notification Lambda Function
# ------------------------------------------------------------------------------

# Package Inline Lambda Code into Zip
data "archive_file" "cost_anomaly_slack_notifier_zip" {
  type        = "zip"
  output_path = "${path.module}/cost_anomaly_slack_notifier.zip"

  source {
    content  = <<EOF
const https = require('https');
const url = require('url');

exports.handler = async (event) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const environment = process.env.ENVIRONMENT || 'dev';

  for (const record of event.Records || []) {
    const snsMsg = record.Sns ? record.Sns.Message : "";
    let alertData = {};
    try {
      alertData = JSON.parse(snsMsg);
    } catch (e) {
      alertData = { rawMessage: snsMsg };
    }

    const impact = alertData.impact || {};
    const maxImpactVal = impact.maxImpact != null ? Number(impact.maxImpact).toFixed(2) : 'N/A';
    const maxImpact = maxImpactVal !== 'N/A' ? `$${maxImpactVal}` : 'N/A';
    const actualSpend = impact.totalActualSpend != null ? `$${Number(impact.totalActualSpend).toFixed(2)}` : 'N/A';
    const expectedSpend = impact.totalExpectedSpend != null ? `$${Number(impact.totalExpectedSpend).toFixed(2)}` : 'N/A';
    const impactPct = impact.totalImpactPercentage != null ? `+${Number(impact.totalImpactPercentage).toFixed(1)}%` : 'N/A';

    const rootCauses = alertData.rootCauses || [];
    const primaryCause = rootCauses[0] || {};
    const serviceName = primaryCause.service || (alertData.anomalyScore ? 'AWS Cost Explorer Service' : 'AWS Service (Multi-Resource)');
    const region = primaryCause.region || process.env.AWS_REGION || 'us-east-1';
    const usageType = primaryCause.usageType || 'Multiple Usage Types';

    const accountId = alertData.accountId || 'Unknown Account';
    const anomalyId = alertData.anomalyId || 'N/A';
    const startDate = alertData.anomalyStartDate || new Date().toISOString();

    const consoleUrl = `https://console.aws.amazon.com/cost-management/home#/anomaly-detection/anomalies/${anomalyId}`;

    console.log(`[Cost Alert] Service: ${serviceName}, Impact: ${maxImpact}, Expected: ${expectedSpend}, Actual: ${actualSpend}`);

    if (!webhookUrl) {
      console.log("SLACK_WEBHOOK_URL is not set. Anomaly details output to logs.");
      continue;
    }

    const slackMessage = {
      text: `:rotating_light: *AWS Cost Anomaly Alert* [${environment.toUpperCase()}] - ${serviceName} (+${maxImpact})`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `🚨 AWS Cost Anomaly Alert [${environment.toUpperCase()}]`,
            emoji: true
          }
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Affected Service:*\n\`${serviceName}\`` },
            { type: "mrkdwn", text: `*Cost Impact (Delta):*\n\`+${maxImpact}\`` },
            { type: "mrkdwn", text: `*Expected Spend:*\n${expectedSpend}` },
            { type: "mrkdwn", text: `*Actual Spend:*\n*${actualSpend}* (${impactPct})` },
            { type: "mrkdwn", text: `*AWS Account / Region:*\n${accountId} (${region})` },
            { type: "mrkdwn", text: `*Usage Type / Detail:*\n\`${usageType}\`` }
          ]
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Detection Window:* ${startDate}\n*Anomaly ID:* \`${anomalyId}\``
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View Anomaly in Console" },
              url: consoleUrl,
              style: "primary"
            }
          ]
        }
      ]
    };

    await postToSlack(webhookUrl, slackMessage);
  }
};

function postToSlack(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const parsedUrl = url.parse(webhookUrl);
    const postData = JSON.stringify(payload);

    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve(body));
    });

    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}
EOF
    filename = "index.js"
  }
}

# IAM Role for Lambda
resource "aws_iam_role" "cost_anomaly_lambda_role" {
  name = "remit-mortgage-cost-anomaly-lambda-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Environment = var.environment
    ManagedBy   = "Terraform"
    Project     = "RemitMortgage"
  }
}

# Basic Execution Policy (CloudWatch Logs)
resource "aws_iam_role_policy_attachment" "cost_anomaly_lambda_logs" {
  role       = aws_iam_role.cost_anomaly_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Lambda Function Definition
resource "aws_lambda_function" "cost_anomaly_slack_notifier" {
  filename         = data.archive_file.cost_anomaly_slack_notifier_zip.output_path
  source_code_hash = data.archive_file.cost_anomaly_slack_notifier_zip.output_base64sha256
  function_name    = "remit-mortgage-cost-anomaly-notifier-${var.environment}"
  role             = aws_iam_role.cost_anomaly_lambda_role.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 30

  environment {
    variables = {
      SLACK_WEBHOOK_URL = var.slack_webhook_url
      ENVIRONMENT       = var.environment
    }
  }

  tags = {
    Name        = "remit-mortgage-cost-anomaly-notifier-${var.environment}"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Project     = "RemitMortgage"
  }
}

# SNS Subscription to Lambda
resource "aws_sns_topic_subscription" "slack_lambda_subscription" {
  topic_arn = aws_sns_topic.cost_anomaly_alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.cost_anomaly_slack_notifier.arn
}

# Lambda Permission for SNS Invocation
resource "aws_lambda_permission" "allow_sns_to_call_lambda" {
  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cost_anomaly_slack_notifier.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.cost_anomaly_alerts.arn
}

# ── Outputs consumed by docs/COST_ANOMALY_TRIAGE_RUNBOOK.md's runbook-ref
# blocks (see docs/RUNBOOK_DRIFT_DETECTION.md) so the triage runbook's cited
# resource names and threshold stay checkable against live infrastructure.
output "cost_anomaly_alerts_topic_name" {
  description = "Name of the SNS topic AWS Cost Anomaly Detection publishes to"
  value       = aws_sns_topic.cost_anomaly_alerts.name
}

output "cost_anomaly_notifier_function_name" {
  description = "Name of the Lambda function that posts cost anomaly alerts to Slack"
  value       = aws_lambda_function.cost_anomaly_slack_notifier.function_name
}

output "cost_anomaly_threshold_usd" {
  description = "Dollar impact threshold that triggers a cost anomaly alert"
  value       = var.cost_anomaly_threshold_amount
}
