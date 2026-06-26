const express = require('express');
const router = express.Router();
const { authenticate, requireAdmin } = require('../../middleware/auth');
const { anonymizeUser } = require('../../jobs/anonymizeDeactivatedUsers');
const { Pool } = require('pg');
const logger = require('../../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * POST /api/admin/users/:id/anonymize
 * Trigger immediate anonymization for a specific user (GDPR manual request)
 * Protected: Admin only
 */
router.post(
  '/:id/anonymize',
  authenticate,
  requireAdmin,
  async (req, res) => {
    const userId = req.params.id;
    const client = await pool.connect();

    try {
      // Verify user exists and is not already anonymized
      const { rows: userRows } = await client.query(
        `SELECT id, email, name, deactivated_at, anonymized_at 
         FROM users 
         WHERE id = $1
         FOR UPDATE`,
        [userId]
      );

      if (userRows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'User not found',
        });
      }

      const user = userRows[0];

      if (user.anonymized_at !== null) {
        return res.status(400).json({
          success: false,
          error: 'User is already anonymized',
          anonymized_at: user.anonymized_at,
        });
      }

      // Optional: Require user to be deactivated first
      if (user.deactivated_at === null) {
        return res.status(400).json({
          success: false,
          error: 'User must be deactivated before anonymization',
        });
      }

      await client.query('BEGIN');

      // Perform anonymization
      await anonymizeUser(client, user);

      await client.query('COMMIT');

      logger.info(`Admin ${req.user.id} triggered anonymization for user ${userId}`);

      return res.status(200).json({
        success: true,
        message: 'User data anonymized successfully',
        data: {
          user_id: userId,
          anonymized_at: new Date().toISOString(),
          fields_scrubbed: ['email', 'name', 'phone', 'stellar_public_key', 'seed_phrase'],
          address_book_deleted: true,
          orders_partially_anonymized: true,
        },
      });

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Admin anonymization failed for user ${userId}:`, error);
      
      return res.status(500).json({
        success: false,
        error: 'Anonymization failed',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      });
    } finally {
      client.release();
    }
  }
);

/**
 * GET /api/admin/users/pending-anonymization
 * List users pending anonymization (for admin dashboard)
 */
router.get(
  '/pending-anonymization',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, email, name, deactivated_at,
                NOW() - deactivated_at AS time_since_deactivation
         FROM users 
         WHERE deactivated_at IS NOT NULL 
           AND anonymized_at IS NULL
         ORDER BY deactivated_at ASC`
      );

      return res.status(200).json({
        success: true,
        count: rows.length,
        data: rows,
      });
    } catch (error) {
      logger.error('Failed to fetch pending anonymizations:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch pending anonymizations',
      });
    }
  }
);

module.exports = router;