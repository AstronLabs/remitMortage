const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Field mapping for user PII anonymization
const ANONYMIZATION_RULES = {
  email: (userId) => `anon_${userId}@deleted.local`,
  name: () => 'Deleted User',
  phone: () => null,
  stellar_public_key: () => null,
  seed_phrase: () => null,
};

/**
 * Anonymizes a single user's PII data
 * @param {Object} client - PostgreSQL client (transaction)
 * @param {Object} user - User object to anonymize
 */
async function anonymizeUser(client, user) {
  const { id } = user;

  // 1. Anonymize core user fields
  const anonymizedEmail = ANONYMIZATION_RULES.email(id);
  const anonymizedName = ANONYMIZATION_RULES.name();

  await client.query(
    `UPDATE users 
     SET email = $1,
         name = $2,
         phone = $3,
         stellar_public_key = $4,
         seed_phrase = $5,
         anonymized_at = NOW(),
         updated_at = NOW()
     WHERE id = $6`,
    [
      anonymizedEmail,
      anonymizedName,
      ANONYMIZATION_RULES.phone(),
      ANONYMIZATION_RULES.stellar_public_key(),
      ANONYMIZATION_RULES.seed_phrase(),
      id,
    ]
  );

  // 2. Delete all address book entries for the user
  await client.query(
    `DELETE FROM address_book_entries WHERE user_id = $1`,
    [id]
  );

  // 3. Partial anonymization of order records
  // Retain financial data and buyer_id (referential integrity)
  // Anonymize buyer name in order metadata/emails
  await client.query(
    `UPDATE orders 
     SET buyer_name = $1,
         buyer_email = $2,
         updated_at = NOW()
     WHERE buyer_id = $3`,
    [anonymizedName, anonymizedEmail, id]
  );

  // 4. Anonymize message content (if messaging table exists)
  await client.query(
    `UPDATE messages 
     SET sender_name = $1,
         content = '[Message deleted — user anonymized]',
         updated_at = NOW()
     WHERE sender_id = $2`,
    [anonymizedName, id]
  );

  logger.info(`User ${id} anonymized successfully`);
}

/**
 * Main job: Anonymize all users deactivated > 30 days ago
 */
async function runAnonymizationJob() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Find users eligible for anonymization
    const { rows: usersToAnonymize } = await client.query(
      `SELECT id, email, name, deactivated_at 
       FROM users 
       WHERE deactivated_at < NOW() - INTERVAL '30 days'
         AND anonymized_at IS NULL
         AND deactivated_at IS NOT NULL
       FOR UPDATE SKIP LOCKED`
    );

    if (usersToAnonymize.length === 0) {
      logger.info('No users pending anonymization');
      await client.query('COMMIT');
      return { processed: 0 };
    }

    logger.info(`Found ${usersToAnonymize.length} users to anonymize`);

    for (const user of usersToAnonymize) {
      try {
        await anonymizeUser(client, user);
      } catch (error) {
        logger.error(`Failed to anonymize user ${user.id}:`, error);
        // Continue with next user; individual failures shouldn't block batch
      }
    }

    await client.query('COMMIT');
    logger.info(`Anonymization job completed: ${usersToAnonymize.length} users processed`);

    return { processed: usersToAnonymize.length };

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Anonymization job failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Export for scheduled job runner (node-cron, bull, etc.)
module.exports = {
  runAnonymizationJob,
  anonymizeUser,
};

// If run directly (CLI/manual execution)
if (require.main === module) {
  runAnonymizationJob()
    .then((result) => {
      console.log('Job result:', result);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Job failed:', error);
      process.exit(1);
    });
}