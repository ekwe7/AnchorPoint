import { Request, Response } from 'express';
import { z } from 'zod';
import { circuitBreakerConfig, CircuitBreakerState } from '../config/circuit-breaker';

/**
 * Circuit Breaker Service
 * 
 * Manages protocol-wide circuit breaker state with:
 * - Tiered pausing (swap only, withdrawal only, full)
 * - Timelocked unpausing
 * - Price volatility monitoring
 */

// In-memory state (in production, use Redis or database)
let circuitBreakerState: CircuitBreakerState = {
  isPaused: false,
  pauseLevel: 'none',
  pauseActivatedAt: null,
  unpauseRequestedAt: null,
  unpauseAvailableAt: null,
  maxVolatilityBps: 500,
  lastPriceCheck: null,
  lastTriggerTime: null,
};

// Timelock duration in milliseconds (1 hour)
const UNPAUSE_TIMELOCK_MS = 3600 * 1000;

// Minimum time between triggers (5 minutes)
const MIN_TRIGGER_INTERVAL_MS = 5 * 60 * 1000;

export const getCircuitBreakerState = (): CircuitBreakerState => {
  return { ...circuitBreakerState };
};

export const isOperationAllowed = (operation: 'deposit' | 'withdraw' | 'swap'): boolean => {
  if (!circuitBreakerState.isPaused) {
    return true;
  }

  switch (circuitBreakerState.pauseLevel) {
    case 'none':
      return true;
    case 'swap_only':
      return operation !== 'swap';
    case 'withdrawal_only':
      return operation !== 'withdraw';
    case 'full':
      return false;
    default:
      return true;
  }
};

export const pauseProtocol = (
  level: 'swap_only' | 'withdrawal_only' | 'full',
  reason: string
): CircuitBreakerState => {
  const now = Date.now();
  
  circuitBreakerState = {
    ...circuitBreakerState,
    isPaused: true,
    pauseLevel: level,
    pauseActivatedAt: now,
    unpauseRequestedAt: null,
    unpauseAvailableAt: null,
    lastTriggerTime: now,
  };

  console.log(`[CircuitBreaker] Protocol paused: ${level} - ${reason}`);
  
  return circuitBreakerState;
};

export const requestUnpause = (): { success: boolean; availableAt: number; message: string } => {
  if (!circuitBreakerState.isPaused) {
    return { success: false, availableAt: 0, message: 'Protocol is not paused' };
  }

  if (circuitBreakerState.unpauseRequestedAt !== null) {
    return { 
      success: false, 
      availableAt: circuitBreakerState.unpauseAvailableAt || 0, 
      message: 'Unpause already requested' 
    };
  }

  const now = Date.now();
  const availableAt = now + UNPAUSE_TIMELOCK_MS;

  circuitBreakerState = {
    ...circuitBreakerState,
    unpauseRequestedAt: now,
    unpauseAvailableAt: availableAt,
  };

  console.log(`[CircuitBreaker] Unpause requested. Available at: ${new Date(availableAt).toISOString()}`);
  
  return { success: true, availableAt, message: 'Unpause requested. Timelock activated.' };
};

export const executeUnpause = (): { success: boolean; message: string } => {
  if (!circuitBreakerState.isPaused) {
    return { success: false, message: 'Protocol is not paused' };
  }

  if (circuitBreakerState.unpauseRequestedAt === null) {
    return { success: false, message: 'No unpause request pending' };
  }

  const now = Date.now();
  const availableAt = circuitBreakerState.unpauseAvailableAt || 0;

  if (now < availableAt) {
    const remainingSeconds = Math.ceil((availableAt - now) / 1000);
    return { 
      success: false, 
      message: `Timelock not yet expired. ${remainingSeconds} seconds remaining.` 
    };
  }

  circuitBreakerState = {
    ...circuitBreakerState,
    isPaused: false,
    pauseLevel: 'none',
    pauseActivatedAt: null,
    unpauseRequestedAt: null,
    unpauseAvailableAt: null,
  };

  console.log('[CircuitBreaker] Protocol unpaused');
  
  return { success: true, message: 'Protocol unpaused successfully' };
};

export const triggerByBot = (
  botId: string,
  level: 'swap_only' | 'withdrawal_only' | 'full',
  reason: string
): { success: boolean; message: string } => {
  const now = Date.now();
  
  // Rate limiting check
  if (circuitBreakerState.lastTriggerTime) {
    const timeSinceLastTrigger = now - circuitBreakerState.lastTriggerTime;
    if (timeSinceLastTrigger < MIN_TRIGGER_INTERVAL_MS) {
      return { 
        success: false, 
        message: `Trigger too soon after last trigger. Wait ${Math.ceil((MIN_TRIGGER_INTERVAL_MS - timeSinceLastTrigger) / 1000)} more seconds.` 
      };
    }
  }

  circuitBreakerState = {
    ...circuitBreakerState,
    isPaused: true,
    pauseLevel: level,
    pauseActivatedAt: now,
    unpauseRequestedAt: null,
    unpauseAvailableAt: null,
    lastTriggerTime: now,
  };

  console.log(`[CircuitBreaker] Triggered by bot ${botId}: ${level} - ${reason}`);
  
  return { success: true, message: `Circuit breaker triggered: ${level}` };
};

export const triggerByVolatility = (
  asset: string,
  oldPrice: number,
  newPrice: number
): { success: boolean; triggered: boolean; level: string; message: string } => {
  const now = Date.now();
  
  // Rate limiting check
  if (circuitBreakerState.lastTriggerTime) {
    const timeSinceLastTrigger = now - circuitBreakerState.lastTriggerTime;
    if (timeSinceLastTrigger < MIN_TRIGGER_INTERVAL_MS) {
      return { 
        success: false, 
        triggered: false, 
        level: 'none',
        message: 'Trigger too soon after last trigger' 
      };
    }
  }

  // Calculate price change in basis points
  const priceChangeBps = oldPrice > 0 
    ? (Math.abs(newPrice - oldPrice) * 10000) / oldPrice 
    : 0;

  const maxVolatility = circuitBreakerState.maxVolatilityBps;

  if (priceChangeBps <= maxVolatility) {
    return { 
      success: true, 
      triggered: false, 
      level: 'none',
      message: `Price volatility (${priceChangeBps.toFixed(2)} bps) within threshold (${maxVolatility} bps)` 
    };
  }

  // Determine pause level based on volatility severity
  let level: 'swap_only' | 'withdrawal_only' | 'full';
  let reason: string;

  if (priceChangeBps > maxVolatility * 3) {
    level = 'full';
    reason = `Severe price volatility: ${priceChangeBps.toFixed(2)}%`;
  } else if (priceChangeBps > maxVolatility * 2) {
    level = 'withdrawal_only';
    reason = `High price volatility: ${priceChangeBps.toFixed(2)}%`;
  } else {
    level = 'swap_only';
    reason = `Moderate price volatility: ${priceChangeBps.toFixed(2)}%`;
  }

  circuitBreakerState = {
    ...circuitBreakerState,
    isPaused: true,
    pauseLevel: level,
    pauseActivatedAt: now,
    unpauseRequestedAt: null,
    unpauseAvailableAt: null,
    lastPriceCheck: now,
    lastTriggerTime: now,
  };

  console.log(`[CircuitBreaker] Triggered by volatility for ${asset}: ${level} - ${reason}`);
  
  return { success: true, triggered: true, level, message: reason };
};

export const updateMaxVolatility = (maxVolatilityBps: number): CircuitBreakerState => {
  if (maxVolatilityBps < 0 || maxVolatilityBps > 10000) {
    throw new Error('Volatility must be between 0 and 10000 bps');
  }

  circuitBreakerState = {
    ...circuitBreakerState,
    maxVolatilityBps: maxVolatilityBps,
  };

  console.log(`[CircuitBreaker] Max volatility updated to ${maxVolatilityBps} bps`);
  
  return circuitBreakerState;
};

export const resetCircuitBreaker = (): CircuitBreakerState => {
  circuitBreakerState = {
    isPaused: false,
    pauseLevel: 'none',
    pauseActivatedAt: null,
    unpauseRequestedAt: null,
    unpauseAvailableAt: null,
    maxVolatilityBps: 500,
    lastPriceCheck: null,
    lastTriggerTime: null,
  };

  console.log('[CircuitBreaker] Reset to default state');
  
  return circuitBreakerState;
};