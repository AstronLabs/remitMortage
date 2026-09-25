# Runbook: mTLS Certificate Rotation Failure & Expiry Remediation

**Document ID**: RB-DEVOPS-0629  
**Category**: DevOps / Infrastructure / Security  
**Severity**: High (P2 for expiry warning, P1 for active rotation failure/stale cert)  
**Target Services**: Internal Microservices, Gateway, Auth Service, Soroban RPC Proxy  

---

## 1. Overview & Triggers

This runbook defines the standard operating procedures (SOP) for diagnosing and remediating internal mutual TLS (mTLS) certificate expiry alerts and rotation failures detected by the automated `mtlsRotationVerifier` background job.

### Trigger Conditions
* **Expiry Alert (`[mTLS Expiry Alert]`)**: Triggered when an internal service's server/client TLS certificate has **<= 14 days** remaining before expiration.
* **Rotation Failure Alert (`[mTLS Rotation Alert]`)**: Triggered when an internal service is serving a stale or unexpected certificate fingerprint despite an expected certificate rotation deployment.
* **Connection Failure Alert (`[mTLS Verification Error]`)**: Triggered when mTLS handshake fails or service endpoint is unreachable over TLS.

---

## 2. Immediate Diagnostic Steps

### Step 2.1: Inspect Automated Verification Logs
Search application logs for the `mTLS Rotation Verifier` audit tags:
```bash
# Filter logs for mTLS verifier alerts
grep -E "\[mTLS Expiry Alert\]|\[mTLS Rotation Alert\]|\[mTLS Verification Error\]" /var/log/remit-mortgage/backend.log
```

### Step 2.2: Test TLS Certificate Expiry and Fingerprint Directly
Use `openssl` to inspect the live peer certificate served by the target service:
```bash
# Replace host and port with target service endpoint (e.g., auth-service:8443)
openssl s_client -connect auth-service:8443 -servername auth-service -showcerts </dev/null 2>/dev/null | openssl x509 -noout -dates -fingerprint -sha256
```

Expected Output:
```text
notBefore=Jan  1 00:00:00 2026 GMT
notAfter=Jan  1 00:00:00 2027 GMT
SHA256 Fingerprint=AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF
```

### Step 2.3: Validate mTLS Handshake with Client Certificates
Verify that client certificate authentication is correctly accepted:
```bash
curl -vvv \
  --cert /etc/ssl/certs/internal-client.crt \
  --key /etc/ssl/private/internal-client.key \
  --cacert /etc/ssl/certs/internal-ca.crt \
  https://auth-service:8443/health
```

---

## 3. Step-by-Step Remediation Procedure

### Scenario A: Certificate Expiring Soon (<= 14 Days)

1. **Trigger Manual Secret Store Renewal**:
   Ensure Vault / AWS Secrets Manager has generated the updated certificate bundle:
   ```bash
   # Re-run secrets rotation job manually if needed
   npm run job:secrets-rotation
   ```
2. **Verify Vault / Disk Certificate Bundle**:
   Check if the renewed certificate files are rendered on the service host:
   ```bash
   ls -la /etc/ssl/certs/internal-service.crt
   openssl x509 -in /etc/ssl/certs/internal-service.crt -noout -enddate
   ```
3. **Gracefully Reload Service Process**:
   Send a `SIGHUP` or perform a rolling restart so the service loads the new cert from disk:
   ```bash
   systemctl reload remit-auth-service
   # or for Docker/Kubernetes container pods:
   kubectl rollout restart deployment/auth-service -n remit-mortgage
   ```

---

### Scenario B: Stale Certificate Served (Rotation Failure)

1. **Identify Stale Service Instance**:
   Compare `EXPECTED_MTLS_FINGERPRINTS` environment variable against actual served fingerprint.
2. **Force Certificate File Sync**:
   ```bash
   # Force secret pull from vault store
   vault agent -config=/etc/vault/vault-agent.hcl -once
   ```
3. **Verify Process Socket Reload**:
   Ensure node/TLS listener process has re-bound sockets with updated TLS context.
4. **Update Expected Fingerprint Config (If Intentional)**:
   If rotation was completed with a newly generated CA/cert fingerprint, update `EXPECTED_MTLS_FINGERPRINTS` in `backend/.env`:
   ```env
   EXPECTED_MTLS_FINGERPRINTS="https://auth-service:8443=NEW_SHA256_FINGERPRINT_HERE"
   ```

---

## 4. Emergency Rollback Procedure

If a newly rotated certificate breaks internal mTLS communication due to missing intermediate CA or invalid SAN:

1. **Revert to Previous Certificate Backup**:
   ```bash
   cp /etc/ssl/certs/internal-service.crt.bak /etc/ssl/certs/internal-service.crt
   cp /etc/ssl/private/internal-service.key.bak /etc/ssl/private/internal-service.key
   ```
2. **Reload Service**:
   ```bash
   systemctl reload remit-auth-service
   ```
3. **Verify Health Endpoint**:
   ```bash
   curl -k https://localhost:8443/health
   ```
4. **Notify Security / DevOps On-Call Lead**.

---

## 5. Escalation & Verification Checklist

- [ ] `openssl s_client` returns valid dates (> 14 days remaining).
- [ ] Served fingerprint matches expected fingerprint configuration.
- [ ] `checkEndpointMtls()` returns `valid: true` and `staleCertificateDetected: false`.
- [ ] Application logs confirm `[mTLS Rotation Verifier] Scan completed successfully. All endpoints verified.`
