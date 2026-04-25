import { triggerByVolatility, getCircuitBreakerState } from './circuit-breaker.service';
import { config } from '../config/env';
import logger from '../utils/logger';

/**
 * Price Volatility Monitor Service
 * 
 * Monitors asset prices and triggers circuit breaker based on volatility thresholds.
 * This service can be run as a scheduled job or triggered on-demand.
 */

interface PriceData {
  asset: string;
  price: number;
  timestamp: number;
}

// In-memory price cache (in production, use Redis)
const priceCache: Map<string, PriceData> = new Map();

// Default check interval (in production, configure via env)
const DEFAULT_CHECK_INTERVAL_MS = 60000; // 1 minute

let monitorInterval: NodeJS.Timeout | null = null;
let isMonitoring = false;

/**
 * Update the cached price for an asset
 */
export const updatePrice = (asset: string, price: number): PriceData => {
  const now = Date.now();
  const priceData: PriceData = { asset, price, timestamp: now };
  priceCache.set(asset, priceData);
  logger.info(`[PriceMonitor] Updated price for ${asset}: ${price}`);
  return priceData;
};

/**
 * Get the cached price for an asset
 */
export const getCachedPrice = (asset: string): PriceData | undefined => {
  return priceCache.get(asset);
};

/**
 * Get all cached prices
 */
export const getAllCachedPrices = (): PriceData[] => {
  return Array.from(priceCache.values());
};

/**
 * Check volatility for a specific asset and trigger circuit breaker if needed
 */
export const checkAssetVolatility = async (
  asset: string,
  newPrice: number
): Promise<{ triggered: boolean; level: string; message: string }> => {
  const cachedPrice = priceCache.get(asset);
  
  if (!cachedPrice) {
    // First price update, just cache it
    updatePrice(asset, newPrice);
    return { triggered: false, level: 'none', message: 'Initial price cached' };
  }

  const oldPrice = cachedPrice.price;
  
  // Update the cache with new price
  updatePrice(asset, newPrice);

  // Check if circuit breaker is enabled
  const state = getCircuitBreakerState();
  if (!state.isPaused) {
    // Trigger volatility check
    const result = triggerByVolatility(asset, oldPrice, newPrice);
    return {
      triggered: result.triggered,
      level: result.level,
      message: result.message,
    };
  }

  return { triggered: false, level: 'none', message: 'Circuit breaker already active' };
};

/**
 * Check volatility for all cached assets
 */
export const checkAllAssetsVolatility = async (): Promise<{
  checked: number;
  triggered: number;
  results: Array<{ asset: string; triggered: boolean; level: string; message: string }>;
}> => {
  const results: Array<{ asset: string; triggered: boolean; level: string; message: string }> = [];
  let triggered = 0;

  for (const [asset, priceData] of priceCache.entries()) {
    // In production, fetch fresh price from oracle here
    // For now, we just check the cached price
    const result = await checkAssetVolatility(asset, priceData.price);
    results.push({ asset, ...result });
    if (result.triggered) triggered++;
  }

  return { checked: priceCache.size, triggered, results };
};

/**
 * Start the price volatility monitoring loop
 */
export const startPriceMonitor = (intervalMs: number = DEFAULT_CHECK_INTERVAL_MS): void => {
  if (isMonitoring) {
    logger.warn('[PriceMonitor] Monitor already running');
    return;
  }

  isMonitoring = true;
  monitorInterval = setInterval(async () => {
    try {
      const state = getCircuitBreakerState();
      
      // Only check if circuit breaker is not already triggered
      // (in production, you might want to continue monitoring even when paused)
      if (!state.isPaused) {
        await checkAllAssetsVolatility();
      }
    } catch (error) {
      logger.error('[PriceMonitor] Error in monitoring loop:', error);
    }
  }, intervalMs);

  logger.info(`[PriceMonitor] Started with interval: ${intervalMs}ms`);
};

/**
 * Stop the price volatility monitoring loop
 */
export const stopPriceMonitor = (): void => {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  isMonitoring = false;
  logger.info('[PriceMonitor] Stopped');
};

/**
 * Get monitoring status
 */
export const getMonitorStatus = (): {
  isMonitoring: boolean;
  cachedAssets: number;
  intervalMs: number;
} => {
  return {
    isMonitoring,
    cachedAssets: priceCache.size,
    intervalMs: DEFAULT_CHECK_INTERVAL_MS,
  };
};

/**
 * Simulate price update (for testing/demo)
 * In production, this would be replaced by oracle price feeds
 */
export const simulatePriceUpdate = async (
  asset: string,
  changePercent: number
): Promise<{ oldPrice: number; newPrice: number; triggered: boolean; level: string }> => {
  const cachedPrice = priceCache.get(asset);
  const oldPrice = cachedPrice?.price || 100; // Default base price
  
  // Calculate new price with given percentage change
  const change = oldPrice * (changePercent / 100);
  const newPrice = oldPrice + change;

  const result = await checkAssetVolatility(asset, newPrice);

  return {
    oldPrice,
    newPrice,
    triggered: result.triggered,
    level: result.level,
  };
};

/**
 * Initialize with some demo prices
 */
export const initializeDemoPrices = (): void => {
  // Initialize with some default prices for demo purposes
  updatePrice('USDC', 1.0);
  updatePrice('BTC', 45000.0);
  updatePrice('ETH', 2500.0);
  updatePrice('XLM', 0.12);
  
  logger.info('[PriceMonitor] Initialized demo prices');
};