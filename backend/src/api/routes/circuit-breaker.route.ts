import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  getCircuitBreakerState,
  isOperationAllowed,
  pauseProtocol,
  requestUnpause,
  executeUnpause,
  triggerByBot,
  triggerByVolatility,
  updateMaxVolatility,
  resetCircuitBreaker,
} from '../../services/circuit-breaker.service';
import {
  getPauseLevelDescription,
} from '../config/circuit-breaker';
import {
  getMonitorStatus,
  checkAssetVolatility,
  getAllCachedPrices,
  simulatePriceUpdate,
  initializeDemoPrices,
  startPriceMonitor,
  stopPriceMonitor,
} from '../../services/price-monitor.service';

const router = Router();

// Validation schemas
const pauseSchema = z.object({
  level: z.enum(['swap_only', 'withdrawal_only', 'full']),
  reason: z.string().min(1).max(500),
});

const triggerByBotSchema = z.object({
  bot_id: z.string().min(1),
  level: z.enum(['swap_only', 'withdrawal_only', 'full']),
  reason: z.string().min(1).max(500),
});

const triggerByVolatilitySchema = z.object({
  asset: z.string().min(1),
  old_price: z.number().positive(),
  new_price: z.number().positive(),
});

const updateConfigSchema = z.object({
  max_volatility_bps: z.number().min(0).max(10000).optional(),
});

/**
 * @swagger
 * /circuit-breaker/status:
 *   get:
 *     summary: Get circuit breaker status
 *     description: Returns the current status of the circuit breaker including pause level and timing info
 *     tags: [Circuit Breaker]
 *     responses:
 *       200:
 *         description: Circuit breaker status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     isPaused:
 *                       type: boolean
 *                     pauseLevel:
 *                       type: string
 *                       enum: [none, swap_only, withdrawal_only, full]
 *                     pauseLevelDescription:
 *                       type: string
 *                     pauseActivatedAt:
 *                       type: string
 *                       nullable: true
 *                     unpauseRequestedAt:
 *                       type: string
 *                       nullable: true
 *                     unpauseAvailableAt:
 *                       type: string
 *                       nullable: true
 *                     maxVolatilityBps:
 *                       type: number
 *                     lastPriceCheck:
 *                       type: string
 *                       nullable: true
 *                     lastTriggerTime:
 *                       type: string
 *                       nullable: true
 */
router.get('/status', (req, res: Response) => {
  const state = getCircuitBreakerState();
  
  res.json({
    status: 'success',
    data: {
      ...state,
      pauseLevelDescription: getPauseLevelDescription(state.pauseLevel),
      pauseActivatedAt: state.pauseActivatedAt ? new Date(state.pauseActivatedAt).toISOString() : null,
      unpauseRequestedAt: state.unpauseRequestedAt ? new Date(state.unpauseRequestedAt).toISOString() : null,
      unpauseAvailableAt: state.unpauseAvailableAt ? new Date(state.unpauseAvailableAt).toISOString() : null,
      lastPriceCheck: state.lastPriceCheck ? new Date(state.lastPriceCheck).toISOString() : null,
      lastTriggerTime: state.lastTriggerTime ? new Date(state.lastTriggerTime).toISOString() : null,
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/check-operation:
 *   get:
 *     summary: Check if operation is allowed
 *     description: Check if a specific operation type is currently allowed given the circuit breaker state
 *     tags: [Circuit Breaker]
 *     parameters:
 *       - in: query
 *         name: operation
 *         required: true
 *         schema:
 *           type: string
 *           enum: [deposit, withdraw, swap]
 *         description: The operation type to check
 *     responses:
 *       200:
 *         description: Operation check result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     operation:
 *                       type: string
 *                     allowed:
 *                       type: boolean
 *                     reason:
 *                       type: string
 *                       nullable: true
 */
router.get('/check-operation', (req, res: Response) => {
  const { operation } = req.query;
  
  if (!operation || !['deposit', 'withdraw', 'swap'].includes(operation as string)) {
    return res.status(400).json({
      status: 'error',
      error: 'Invalid operation. Must be one of: deposit, withdraw, swap',
    });
  }

  const allowed = isOperationAllowed(operation as 'deposit' | 'withdraw' | 'swap');
  const state = getCircuitBreakerState();
  
  res.json({
    status: 'success',
    data: {
      operation,
      allowed,
      reason: allowed ? null : `Operation blocked due to ${state.pauseLevel} pause level`,
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/pause:
 *   post:
 *     summary: Pause the protocol
 *     description: Pause the protocol with a specific level. Requires admin authentication.
 *     tags: [Circuit Breaker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - level
 *               - reason
 *             properties:
 *               level:
 *                 type: string
 *                 enum: [swap_only, withdrawal_only, full]
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Protocol paused successfully
 *       401:
 *         description: Unauthorized
 */
router.post('/pause', authMiddleware, validate({ body: pauseSchema }), (req: AuthRequest, res: Response) => {
  const { level, reason } = req.body;
  
  // In production, check if user has admin role
  // For now, allow any authenticated user
  
  const state = pauseProtocol(level, reason);
  
  res.json({
    status: 'success',
    data: {
      ...state,
      message: `Protocol paused: ${getPauseLevelDescription(level)}`,
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/unpause/request:
 *   post:
 *     summary: Request unpause
 *     description: Start the timelock period for unpausing the protocol. Requires admin authentication.
 *     tags: [Circuit Breaker]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Unpause requested successfully
 *       401:
 *         description: Unauthorized
 */
router.post('/unpause/request', authMiddleware, (req: AuthRequest, res: Response) => {
  const result = requestUnpause();
  
  if (!result.success) {
    return res.status(400).json({
      status: 'error',
      error: result.message,
    });
  }
  
  res.json({
    status: 'success',
    data: {
      message: result.message,
      availableAt: new Date(result.availableAt).toISOString(),
      timelockSeconds: 3600,
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/unpause/execute:
 *   post:
 *     summary: Execute unpause
 *     description: Execute the unpause after timelock has expired. Requires admin authentication.
 *     tags: [Circuit Breaker]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Protocol unpaused successfully
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Timelock not yet expired or no unpause pending
 */
router.post('/unpause/execute', authMiddleware, (req: AuthRequest, res: Response) => {
  const result = executeUnpause();
  
  if (!result.success) {
    return res.status(400).json({
      status: 'error',
      error: result.message,
    });
  }
  
  res.json({
    status: 'success',
    data: {
      message: result.message,
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/trigger/bot:
 *   post:
 *     summary: Trigger by authorized bot
 *     description: Allow an authorized bot to trigger the circuit breaker autonomously
 *     tags: [Circuit Breaker]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - bot_id
 *               - level
 *               - reason
 *             properties:
 *               bot_id:
 *                 type: string
 *               level:
 *                 type: string
 *                 enum: [swap_only, withdrawal_only, full]
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Circuit breaker triggered
 *       400:
 *         description: Trigger failed (rate limited or unauthorized)
 */
router.post('/trigger/bot', validate({ body: triggerByBotSchema }), (req, res: Response) => {
  const { bot_id, level, reason } = req.body;
  
  const result = triggerByBot(bot_id, level, reason);
  
  if (!result.success) {
    return res.status(400).json({
      status: 'error',
      error: result.message,
    });
  }
  
  res.json({
    status: 'success',
    data: {
      message: result.message,
      pauseLevel: level,
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/trigger/volatility:
 *   post:
 *     summary: Trigger by price volatility
 *     description: Check price volatility and trigger circuit breaker if threshold exceeded
 *     tags: [Circuit Breaker]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - asset
 *               - old_price
 *               - new_price
 *             properties:
 *               asset:
 *                 type: string
 *               old_price:
 *                 type: number
 *               new_price:
 *                 type: number
 *     responses:
 *       200:
 *         description: Volatility check result
 */
router.post('/trigger/volatility', validate({ body: triggerByVolatilitySchema }), (req, res: Response) => {
  const { asset, old_price, new_price } = req.body;
  
  const result = triggerByVolatility(asset, old_price, new_price);
  
  res.json({
    status: 'success',
    data: {
      triggered: result.triggered,
      level: result.level,
      message: result.message,
      priceChangeBps: old_price > 0 
        ? (Math.abs(new_price - old_price) * 10000) / old_price 
        : 0,
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/config:
 *   patch:
 *     summary: Update circuit breaker configuration
 *     description: Update configuration like max volatility threshold. Requires admin authentication.
 *     tags: [Circuit Breaker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               max_volatility_bps:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 10000
 *     responses:
 *       200:
 *         description: Configuration updated
 */
router.patch('/config', authMiddleware, validate({ body: updateConfigSchema }), (req: AuthRequest, res: Response) => {
  const { max_volatility_bps } = req.body;
  
  try {
    if (max_volatility_bps !== undefined) {
      updateMaxVolatility(max_volatility_bps);
    }
    
    const state = getCircuitBreakerState();
    
    res.json({
      status: 'success',
      data: {
        maxVolatilityBps: state.maxVolatilityBps,
        message: 'Configuration updated',
      },
    });
  } catch (error) {
    res.status(400).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Configuration update failed',
    });
  }
});

/**
 * @swagger
 * /circuit-breaker/reset:
 *   post:
 *     summary: Reset circuit breaker
 *     description: Reset circuit breaker to default state. Requires admin authentication.
 *     tags: [Circuit Breaker]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Circuit breaker reset
 */
router.post('/reset', authMiddleware, (req: AuthRequest, res: Response) => {
  const state = resetCircuitBreaker();
  
  res.json({
    status: 'success',
    data: {
      message: 'Circuit breaker reset to default state',
      state,
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/monitor/status:
 *   get:
 *     summary: Get price monitor status
 *     description: Get the current status of the price volatility monitor
 *     tags: [Circuit Breaker]
 *     responses:
 *       200:
 *         description: Monitor status
 */
router.get('/monitor/status', (req, res: Response) => {
  const status = getMonitorStatus();
  const prices = getAllCachedPrices();
  
  res.json({
    status: 'success',
    data: {
      ...status,
      prices,
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/monitor/start:
 *   post:
 *     summary: Start price monitor
 *     description: Start the automated price volatility monitoring loop
 *     tags: [Circuit Breaker]
 *     responses:
 *       200:
 *         description: Monitor started
 */
router.post('/monitor/start', (req, res: Response) => {
  const { interval_ms } = req.query;
  const interval = interval_ms ? parseInt(interval_ms as string, 10) : undefined;
  
  startPriceMonitor(interval);
  
  res.json({
    status: 'success',
    data: {
      message: 'Price monitor started',
      intervalMs: interval || 60000,
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/monitor/stop:
 *   post:
 *     summary: Stop price monitor
 *     description: Stop the automated price volatility monitoring loop
 *     tags: [Circuit Breaker]
 *     responses:
 *       200:
 *         description: Monitor stopped
 */
router.post('/monitor/stop', (req, res: Response) => {
  stopPriceMonitor();
  
  res.json({
    status: 'success',
    data: {
      message: 'Price monitor stopped',
    },
  });
});

/**
 * @swagger
 * /circuit-breaker/monitor/check:
 *   post:
 *     summary: Check asset volatility
 *     description: Manually trigger a volatility check for an asset
 *     tags: [Circuit Breaker]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - asset
 *               - price
 *             properties:
 *               asset:
 *                 type: string
 *               price:
 *                 type: number
 *     responses:
 *       200:
 *         description: Volatility check result
 */
router.post('/monitor/check', (req, res: Response) => {
  const { asset, price } = req.body;
  
  if (!asset || price === undefined) {
    return res.status(400).json({
      status: 'error',
      error: 'asset and price are required',
    });
  }
  
  checkAssetVolatility(asset, price).then(result => {
    res.json({
      status: 'success',
      data: {
        asset,
        oldPrice: getAllCachedPrices().find(p => p.asset === asset)?.price,
        newPrice: price,
        ...result,
      },
    });
  });
});

/**
 * @swagger
 * /circuit-breaker/monitor/simulate:
 *   post:
 *     summary: Simulate price change
 *     description: Simulate a price change for testing the circuit breaker
 *     tags: [Circuit Breaker]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - asset
 *               - change_percent
 *             properties:
 *               asset:
 *                 type: string
 *               change_percent:
 *                 type: number
 *     responses:
 *       200:
 *         description: Simulation result
 */
router.post('/monitor/simulate', (req, res: Response) => {
  const { asset, change_percent } = req.body;
  
  if (!asset || change_percent === undefined) {
    return res.status(400).json({
      status: 'error',
      error: 'asset and change_percent are required',
    });
  }
  
  // Initialize demo prices if not already done
  initializeDemoPrices();
  
  simulatePriceUpdate(asset, change_percent).then(result => {
    res.json({
      status: 'success',
      data: {
        asset,
        ...result,
      },
    });
  });
});

/**
 * @swagger
 * /circuit-breaker/monitor/prices:
 *   get:
 *     summary: Get all cached prices
 *     description: Get all currently cached asset prices
 *     tags: [Circuit Breaker]
 *     responses:
 *       200:
 *         description: List of cached prices
 */
router.get('/monitor/prices', (req, res: Response) => {
  const prices = getAllCachedPrices();
  
  res.json({
    status: 'success',
    data: {
      prices,
      count: prices.length,
    },
  });
});

export default router;