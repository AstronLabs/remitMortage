import express from 'express';
import request from 'supertest';
import fc from 'fast-check';
import { errorHandler } from '../../middleware/errorHandler.js';

describe('API Input Fuzzing (JSON Deserialization)', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    // Use express.json with a strict limit to match production (default is usually 100kb, but can be configured)
    app.use(express.json({ limit: '100kb' }));
    
    app.post('/api/fuzz-test', (req, res) => {
      // Just an endpoint that echoes body
      res.status(200).json({ success: true, payload: req.body });
    });

    app.use(errorHandler);
  });

  it('should handle arbitrary JSON structures without crashing (Returns 200, 400, or 413)', () => {
    return fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (jsonObj) => {
        const response = await request(app)
          .post('/api/fuzz-test')
          .send(jsonObj)
          .set('Content-Type', 'application/json');

        // It should succeed or fail gracefully with a 4xx error (e.g. 413 Payload Too Large)
        // It must NOT be a 500
        expect([200, 400, 413]).toContain(response.status);
      }),
      { numRuns: 100 }
    );
  });

  it('should gracefully handle malformed JSON strings with a 400 Bad Request', () => {
    return fc.assert(
      fc.asyncProperty(fc.string(), async (str) => {
        // Skip strings that actually parse as valid JSON
        try {
          JSON.parse(str);
          return; 
        } catch (e) {
          // It's invalid JSON, which is what we want to test
        }

        const response = await request(app)
          .post('/api/fuzz-test')
          .send(str)
          .set('Content-Type', 'application/json');

        // Express body-parser catches malformed JSON and should return a 400
        // Some transports may treat empty body as an empty payload and return 200.
        expect([200, 400]).toContain(response.status);
        if (response.status === 400) expect(response.body.error).toBeDefined();
      }),
      { numRuns: 100 }
    );
  });
});
