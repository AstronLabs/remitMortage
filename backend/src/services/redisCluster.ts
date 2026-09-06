import Redis, { Cluster, ClusterNode, ClusterOptions } from "ioredis";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

type RedisClient = Cluster | Redis;

let client: RedisClient | null = null;
let clusterClient: Cluster | null = null;
let singleClient: Redis | null = null;

export function isClusterMode(): boolean {
  const config = loadConfig();
  return config.redisClusterEnabled && config.redisClusterNodes.length > 0;
}

function buildClusterNodes(): ClusterNode[] {
  const config = loadConfig();
  return config.redisClusterNodes.map((node) => {
    const [host, port] = node.split(":");
    return { host, port: port ? parseInt(port, 10) : 6379 };
  });
}

function buildClusterOptions(): any {
  const opts: any = {
    lazyConnect: true,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    retryDelayOnFailover: 300,
    retryDelayOnClusterDown: 1000,
    retryDelayOnTryAgain: 100,
    maxRetriesPerRequest: 3,
    clusterRetryStrategy: (times: number) => Math.min(times * 200, 5000),
    redisOptions: {
      retryStrategy: (times: number) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      enableOfflineQueue: true,
      lazyConnect: true,
    },
  };
  return opts;
}

export async function initializeRedisCluster(): Promise<RedisClient | null> {
  if (client) return client;

  const config = loadConfig();
  const useCluster = config.redisClusterEnabled && config.redisClusterNodes.length > 0;

  try {
    if (useCluster) {
      const nodes = buildClusterNodes();
      const options = buildClusterOptions();

      logger.info("[redis-cluster] initializing cluster connection", {
        nodes: nodes.map((n: any) => `${n.host}:${n.port}`),
      });

      clusterClient = new Cluster(nodes, options);
      client = clusterClient;

      clusterClient.on("connect", () => {
        logger.info("[redis-cluster] cluster connected");
      });

      clusterClient.on("ready", () => {
        logger.info("[redis-cluster] cluster ready");
      });

      clusterClient.on("nodeAdded", (node) => {
        logger.info("[redis-cluster] node added", {
          node: `${node.options.host}:${node.options.port}`,
        });
      });

      clusterClient.on("nodeRemoved", (node) => {
        logger.warn("[redis-cluster] node removed", {
          node: `${node.options.host}:${node.options.port}`,
        });
      });

      clusterClient.on("close", () => {
        logger.warn("[redis-cluster] cluster connection closed");
      });

      clusterClient.on("reconnecting", () => {
        logger.info("[redis-cluster] cluster reconnecting");
      });

      clusterClient.on("+node", (node) => {
        logger.info("[redis-cluster] node joined cluster", {
          node: `${node.options.host}:${node.options.port}`,
        });
      });

      clusterClient.on("-node", (node) => {
        logger.warn("[redis-cluster] node left cluster", {
          node: `${node.options.host}:${node.options.port}`,
        });
      });

      clusterClient.on("error", (err) => {
        logger.error("[redis-cluster] cluster error", { error: err.message });
      });

      await clusterClient.cluster("INFO").catch(() => {
        // cluster info may not be available on first connect, ok
      });

      logger.info("[redis-cluster] cluster connection established");
    } else {
      const redisUrl = config.redisUrl;
      if (!redisUrl) {
        logger.warn("[redis-cluster] REDIS_URL not configured; Redis disabled");
        client = null;
        return null;
      }

      logger.info("[redis-cluster] initializing single-node connection", {
        url: redisUrl.replace(/\/\/.*@/, "//***@"),
      });

      const options = {
        lazyConnect: true,
        retryStrategy: (times: number) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        enableOfflineQueue: true,
      };

      singleClient = new Redis(redisUrl, options);
      client = singleClient;

      singleClient.on("connect", () => {
        logger.info("[redis-cluster] single-node connected");
      });

      singleClient.on("error", (err) => {
        logger.error("[redis-cluster] single-node error", { error: err.message });
      });
    }

    return client;
  } catch (error) {
    logger.error("[redis-cluster] failed to initialize", { error });
    client = null;
    return null;
  }
}

export function getClusterClient(): RedisClient | null {
  return client;
}

export function getClusterStatus(): {
  mode: string;
  connected: boolean;
  nodeCount: number;
} {
  if (!client) {
    return { mode: "none", connected: false, nodeCount: 0 };
  }

  if (clusterClient) {
    const nodes = clusterClient.nodes();
    return {
      mode: "cluster",
      connected: clusterClient.status === "ready",
      nodeCount: nodes.length,
    };
  }

  return {
    mode: "single",
    connected: singleClient?.status === "ready",
    nodeCount: singleClient ? 1 : 0,
  };
}

export async function closeCluster(): Promise<void> {
  try {
    if (clusterClient) {
      await clusterClient.quit();
      logger.info("[redis-cluster] cluster connection closed");
    } else if (singleClient) {
      await singleClient.quit();
      logger.info("[redis-cluster] single-node connection closed");
    }
  } catch (error) {
    logger.error("[redis-cluster] error closing connection", { error });
  } finally {
    client = null;
    clusterClient = null;
    singleClient = null;
  }
}

export async function clusterHealthCheck(): Promise<{
  ok: boolean;
  mode: string;
  nodeCount: number;
  pingMs: number | null;
}> {
  if (!client) {
    return { ok: false, mode: "none", nodeCount: 0, pingMs: null };
  }

  const start = Date.now();
  try {
    await client.ping();
    const pingMs = Date.now() - start;

    return {
      ok: true,
      mode: clusterClient ? "cluster" : "single",
      nodeCount: clusterClient ? clusterClient.nodes().length : 1,
      pingMs,
    };
  } catch (error) {
    return {
      ok: false,
      mode: clusterClient ? "cluster" : "single",
      nodeCount: clusterClient ? clusterClient.nodes().length : 0,
      pingMs: null,
    };
  }
}
