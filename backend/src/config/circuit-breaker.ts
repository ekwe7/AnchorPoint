/**
 * Circuit Breaker Configuration
 * 
 * Defines the configuration options for the protocol-wide circuit breaker.
 */

export type PauseLevel = 'none' | 'swap_only' | 'withdrawal_only' | 'full';

export interface CircuitBreakerState {
  isPaused: boolean;
  pauseLevel: PauseLevel;
  pauseActivatedAt: number | null;
  unpauseRequestedAt: number | null;
  unpauseAvailableAt: number | null;
  maxVolatilityBps: number;
  lastPriceCheck: number | null;
  lastTriggerTime: number | null;
}

export interface CircuitBreakerConfig {
  /** Maximum allowed price volatility in basis points (100 bps = 1%) */
  maxVolatilityBps: number;
  /** Timelock duration in seconds before unpause can be executed */
  unpauseTimelockSeconds: number;
  /** Minimum time between autonomous triggers in seconds */
  minTriggerIntervalSeconds: number;
  /** Whether the circuit breaker is enabled */
  enabled: boolean;
  /** List of authorized bot addresses that can trigger the circuit breaker */
  authorizedBots: string[];
  /** Whether autonomous oracle triggers are enabled */
  oracleTriggersEnabled: boolean;
}

export const circuitBreakerConfig: CircuitBreakerConfig = {
  maxVolatilityBps: parseInt(process.env.CIRCUIT_BREAKER_MAX_VOLATILITY_BPS || '500', 10),
  unpauseTimelockSeconds: parseInt(process.env.CIRCUIT_BREAKER_UNPAUSE_TIMELOCK_SECONDS || '3600', 10),
  minTriggerIntervalSeconds: parseInt(process.env.CIRCUIT_BREAKER_MIN_TRIGGER_INTERVAL_SECONDS || '300', 10),
  enabled: process.env.CIRCUIT_BREAKER_ENABLED !== 'false',
  authorizedBots: process.env.CIRCUIT_BREAKER_AUTHORIZED_BOTS 
    ? process.env.CIRCUIT_BREAKER_AUTHORIZED_BOTS.split(',') 
    : [],
  oracleTriggersEnabled: process.env.CIRCUIT_BREAKER_ORACLE_TRIGGERS_ENABLED !== 'false',
};

/**
 * Get the pause level description for display
 */
export const getPauseLevelDescription = (level: PauseLevel): string => {
  switch (level) {
    case 'none':
      return 'All operations normal';
    case 'swap_only':
      return 'Swap operations paused';
    case 'withdrawal_only':
      return 'Withdrawal operations paused';
    case 'full':
      return 'All operations paused';
    default:
      return 'Unknown';
  }
};

/**
 * Check if a specific operation type is affected by the current pause level
 */
export const isOperationAffected = (operation: 'deposit' | 'withdraw' | 'swap', pauseLevel: PauseLevel): boolean => {
  switch (pauseLevel) {
    case 'none':
      return false;
    case 'swap_only':
      return operation === 'swap';
    case 'withdrawal_only':
      return operation === 'withdraw';
    case 'full':
      return true;
    default:
      return false;
  }
};