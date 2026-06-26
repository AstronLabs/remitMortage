const cron = require('node-cron');
const { runAnonymizationJob } = require('./anonymizeDeactivatedUsers');
const logger = require('../utils/logger');

/**
 * Schedule the GDPR anonymization job
 * Runs daily at 2:00 AM (low-traffic period)
 */
function scheduleAnonymizationJob() {
  // Cron: 0 2 * * * = At 02:00 every day
  cron.schedule('0 2 * * *', async () => {
    logger.info('Starting scheduled GDPR anonymization job');
    try {
      const result = await runAnonymizationJob();
      logger.info('Scheduled anonymization job completed:', result);
    } catch (error) {
      logger.error('Scheduled anonymization job failed:', error);
      // Alerting/notification logic here (e.g., Slack, PagerDuty)
    }
  }, {
    scheduled: true,
    timezone: 'UTC', // Adjust to your timezone
  });

  logger.info('GDPR anonymization job scheduled for 02:00 UTC daily');
}

module.exports = {
  scheduleAnonymizationJob,
};