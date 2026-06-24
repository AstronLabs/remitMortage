import { Router } from "express";

export const borrowerRouter = Router();

/**
 * @openapi
 * /api/borrower/{address}/status:
 *   get:
 *     summary: Get borrower status
 *     description: Returns the current borrower escrow and loan status summary. Contract-backed values are placeholders until Soroban queries are integrated.
 *     tags:
 *       - Borrower
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         description: Borrower Stellar public key.
 *         schema:
 *           type: string
 *           pattern: '^G[A-Z2-7]{55}$'
 *         example: GDXU35N4YDZTX4LU6KM2P5WNOWIBLDE2DYUNCCXKMAO4NSV3WVNGLJXZ
 *     responses:
 *       200:
 *         description: Borrower status summary.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BorrowerStatusResponse'
 *       500:
 *         description: Borrower status lookup failed unexpectedly.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
borrowerRouter.get("/:address/status", async (req, res) => {
  try {
    const { address } = req.params;

    // TODO: Query escrow contract for borrower balance
    // TODO: Query lending pool contract for active loans

    res.json({
      address,
      escrow: {
        deposited: "0",
        target: "0",
        progress: 0,
      },
      loan: {
        status: "none",
        principal: "0",
        disbursed: "0",
        repaid: "0",
      },
    });
  } catch (error) {
    console.error("Borrower status error:", error);
    res.status(500).json({ error: "Failed to fetch borrower status" });
  }
});
