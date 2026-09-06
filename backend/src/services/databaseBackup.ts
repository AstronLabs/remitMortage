import { exec } from "child_process";
import { promisify } from "util";
import { createReadStream, unlinkSync } from "fs";
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { Storage } from "@google-cloud/storage";
import { createCipheriv, randomBytes, createHash } from "crypto";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

const execPromise = promisify(exec);

const config = loadConfig();

interface BackupOptions {
  encryptionKey?: string;
  provider: "aws" | "gcs";
  bucket: string;
}

/**
 * Database Backup Service
 *
 * Provides automated PostgreSQL database backups with encryption and
 * cloud storage upload to AWS S3 or Google Cloud Storage.
 */
export class DatabaseBackupService {
  private s3Client?: S3Client;
  private gcsStorage?: Storage;
  private options: BackupOptions;

  constructor(options: BackupOptions) {
    this.options = options;

    if (options.provider === "aws") {
      this.s3Client = new S3Client({
        region: process.env.AWS_REGION || "us-east-1",
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      });
    } else if (options.provider === "gcs") {
      this.gcsStorage = new Storage({
        projectId: process.env.GCS_PROJECT_ID,
        keyFilename: process.env.GCS_KEY_FILE,
      });
    }
  }

  /**
   * Executes a full PostgreSQL database backup, encrypts it, and uploads
   * to configured cloud storage.
   */
  async executeBackup(): Promise<{ success: boolean; backupKey: string; size: number }> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `remitmortgage-backup-${timestamp}.sql`;
    const encryptedFilename = `${filename}.enc`;

    try {
      logger.info("Starting database backup", { filename });

      // Step 1: Dump PostgreSQL database
      const dumpPath = `/tmp/${filename}`;
      await this.dumpDatabase(dumpPath);

      logger.info("Database dump completed", {
        filename,
        path: dumpPath,
      });

      // Step 2: Encrypt the dump
      const encryptedPath = `/tmp/${encryptedFilename}`;
      await this.encryptFile(dumpPath, encryptedPath);

      logger.info("Backup encrypted", {
        encryptedFilename,
      });

      // Step 3: Upload to cloud storage
      const backupKey = `backups/${encryptedFilename}`;
      const uploadResult = await this.uploadToCloud(encryptedPath, backupKey);

      // Step 4: Cleanup temporary files
      this.cleanupTempFiles([dumpPath, encryptedPath]);

      logger.info("Backup completed successfully", {
        backupKey,
        size: uploadResult.size,
        provider: this.options.provider,
      });

      return {
        success: true,
        backupKey,
        size: uploadResult.size,
      };
    } catch (error) {
      logger.error("Database backup failed", {
        error: error instanceof Error ? error.message : String(error),
        filename,
      });

      throw error;
    }
  }

  /**
   * Dumps the PostgreSQL database to a file using pg_dump
   */
  private async dumpDatabase(outputPath: string): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("DATABASE_URL environment variable is not set");
    }

    // Use pg_dump with compressed output
    const command = `pg_dump "${databaseUrl}" -F c -f "${outputPath}"`;

    try {
      const { stdout, stderr } = await execPromise(command);

      if (stderr && !stderr.includes("Password")) {
        logger.warn("pg_dump stderr output", { stderr });
      }

      if (stdout) {
        logger.debug("pg_dump stdout", { stdout });
      }
    } catch (error) {
      throw new Error(
        `pg_dump failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Encrypts a file using AES-256-CBC
   */
  private async encryptFile(inputPath: string, outputPath: string): Promise<void> {
    const encryptionKey = this.options.encryptionKey || process.env.BACKUP_ENCRYPTION_KEY;

    if (!encryptionKey) {
      throw new Error("Encryption key not provided");
    }

    return new Promise((resolve, reject) => {
      try {
        const key = createHash("sha256").update(encryptionKey).digest();
        const iv = randomBytes(16);
        const cipher = createCipheriv("aes-256-cbc", key, iv);
        const input = createReadStream(inputPath);
        const output = require("fs").createWriteStream(outputPath);

        // Prepend IV to the output so it can be used for decryption
        output.write(iv);

        input
          .pipe(cipher)
          .pipe(output)
          .on("finish", () => resolve())
          .on("error", reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Uploads encrypted backup to cloud storage (AWS S3 or GCS)
   */
  private async uploadToCloud(
    filePath: string,
    key: string
  ): Promise<{ size: number }> {
    const fileStream = createReadStream(filePath);
    const stats = require("fs").statSync(filePath);

    if (this.options.provider === "aws" && this.s3Client) {
      const command = new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: fileStream,
        ServerSideEncryption: "AES256",
        Metadata: {
          timestamp: new Date().toISOString(),
          service: "remitmortgage-backend",
        },
      });

      await this.s3Client.send(command);

      return { size: stats.size };
    } else if (this.options.provider === "gcs" && this.gcsStorage) {
      const bucket = this.gcsStorage.bucket(this.options.bucket);
      const file = bucket.file(key);

      await new Promise((resolve, reject) => {
        fileStream
          .pipe(
            file.createWriteStream({
              metadata: {
                contentType: "application/octet-stream",
                metadata: {
                  timestamp: new Date().toISOString(),
                  service: "remitmortgage-backend",
                },
              },
            })
          )
          .on("finish", resolve)
          .on("error", reject);
      });

      return { size: stats.size };
    }

    throw new Error(`Unsupported cloud provider: ${this.options.provider}`);
  }

  /**
   * Lists backups older than retentionDays and archives them to cold storage
   * (AWS S3 Glacier / GCS Archive), then removes them from the hot bucket.
   */
  async cleanupOldBackups(retentionDays = 30): Promise<{ archived: number; failed: number }> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    let archived = 0;
    let failed = 0;

    logger.info("Starting backup cleanup", { retentionDays, cutoff: cutoff.toISOString() });

    try {
      const keys = await this.listBackupKeys();

      for (const key of keys) {
        const age = this.parseBackupAge(key);
        if (age === null || age > cutoff) continue;

        try {
          await this.moveToColdStorage(key);
          archived++;
          logger.info("Archived old backup to cold storage", { key });
        } catch (err) {
          failed++;
          logger.error("Failed to archive backup", {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error("Backup cleanup enumeration failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info("Backup cleanup complete", { archived, failed });
    return { archived, failed };
  }

  private async listBackupKeys(): Promise<string[]> {
    const prefix = "backups/";

    if (this.options.provider === "aws" && this.s3Client) {
      const command = new ListObjectsV2Command({
        Bucket: this.options.bucket,
        Prefix: prefix,
      });
      const response = await this.s3Client.send(command);
      return (response.Contents ?? []).map((o) => o.Key!).filter(Boolean);
    }

    if (this.options.provider === "gcs" && this.gcsStorage) {
      const bucket = this.gcsStorage.bucket(this.options.bucket);
      const [files] = await bucket.getFiles({ prefix });
      return files.map((f) => f.name);
    }

    throw new Error(`Unsupported cloud provider: ${this.options.provider}`);
  }

  private parseBackupAge(key: string): Date | null {
    const match = key.match(/remitmortgage-backup-(\d{4}-\d{2}-\d{2})/);
    if (!match) return null;
    const date = new Date(match[1] + "T00:00:00Z");
    return isNaN(date.getTime()) ? null : date;
  }

  private async moveToColdStorage(key: string): Promise<void> {
    if (this.options.provider === "aws" && this.s3Client) {
      const copyCommand = new CopyObjectCommand({
        Bucket: this.options.bucket,
        CopySource: `${this.options.bucket}/${key}`,
        Key: key.replace("backups/", "cold-storage/"),
        StorageClass: "GLACIER",
      });
      await this.s3Client.send(copyCommand);

      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
      });
      await this.s3Client.send(deleteCommand);
    } else if (this.options.provider === "gcs" && this.gcsStorage) {
      const bucket = this.gcsStorage.bucket(this.options.bucket);
      const file = bucket.file(key);
      const archiveFile = bucket.file(key.replace("backups/", "cold-storage/"));

      await file.copy(archiveFile);
      await file.delete();
    } else {
      throw new Error(`Unsupported cloud provider: ${this.options.provider}`);
    }
  }

  /**
   * Cleans up temporary files after backup
   */
  private cleanupTempFiles(paths: string[]): void {
    paths.forEach((path) => {
      try {
        unlinkSync(path);
        logger.debug("Cleaned up temporary file", { path });
      } catch (error) {
        logger.warn("Failed to cleanup temporary file", {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Restore database from a backup file
   */
  async restoreFromBackup(backupKey: string, decryptionKey: string): Promise<void> {
    const tempPath = `/tmp/restore-${Date.now()}.sql`;
    const encryptedPath = `${tempPath}.enc`;

    try {
      logger.info("Starting database restore", { backupKey });

      // Step 1: Download from cloud
      await this.downloadFromCloud(backupKey, encryptedPath);

      // Step 2: Decrypt
      await this.decryptFile(encryptedPath, tempPath, decryptionKey);

      // Step 3: Restore to PostgreSQL
      await this.restoreDatabase(tempPath);

      // Step 4: Cleanup
      this.cleanupTempFiles([tempPath, encryptedPath]);

      logger.info("Database restore completed successfully", { backupKey });
    } catch (error) {
      logger.error("Database restore failed", {
        error: error instanceof Error ? error.message : String(error),
        backupKey,
      });

      this.cleanupTempFiles([tempPath, encryptedPath]);
      throw error;
    }
  }

  /**
   * Downloads backup from cloud storage
   */
  private async downloadFromCloud(key: string, outputPath: string): Promise<void> {
    if (this.options.provider === "aws" && this.s3Client) {
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      const command = new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      const writeStream = require("fs").createWriteStream(outputPath);

      await new Promise((resolve, reject) => {
        (response as any).Body.pipe(writeStream)
          .on("finish", resolve)
          .on("error", reject);
      });
    } else if (this.options.provider === "gcs" && this.gcsStorage) {
      const bucket = this.gcsStorage.bucket(this.options.bucket);
      const file = bucket.file(key);

      await file.download({ destination: outputPath });
    } else {
      throw new Error(`Unsupported cloud provider: ${this.options.provider}`);
    }
  }

  /**
   * Decrypts a file using AES-256-CBC
   */
  private async decryptFile(
    inputPath: string,
    outputPath: string,
    decryptionKey: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const { createDecipher } = require("crypto");
        const decipher = createDecipher("aes-256-cbc", decryptionKey);
        const input = createReadStream(inputPath);
        const output = require("fs").createWriteStream(outputPath);

        input
          .pipe(decipher)
          .pipe(output)
          .on("finish", () => resolve())
          .on("error", reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Restores PostgreSQL database from a dump file
   */
  private async restoreDatabase(dumpPath: string): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("DATABASE_URL environment variable is not set");
    }

    const command = `pg_restore -d "${databaseUrl}" -c "${dumpPath}"`;

    try {
      const { stdout, stderr } = await execPromise(command);

      if (stderr && !stderr.includes("Password")) {
        logger.warn("pg_restore stderr output", { stderr });
      }

      if (stdout) {
        logger.debug("pg_restore stdout", { stdout });
      }
    } catch (error) {
      throw new Error(
        `pg_restore failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Create a backup service instance based on environment configuration
 */
export function createBackupService(): DatabaseBackupService {
  const provider = (process.env.BACKUP_PROVIDER || "aws") as "aws" | "gcs";
  const bucket = process.env.BACKUP_BUCKET || "remitmortgage-backups";
  const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY;

  return new DatabaseBackupService({
    provider,
    bucket,
    encryptionKey,
  });
}
