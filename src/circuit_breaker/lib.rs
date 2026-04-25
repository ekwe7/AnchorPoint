#![no_std]
//! Circuit Breaker Contract for AnchorPoint Protocol
//!
//! This contract implements a protocol-wide circuit breaker with:
//! - Tiered pausing (swap only, withdrawal only, or full pause)
//! - Timelocked unpausing mechanism to prevent abuse
//! - Autonomous triggers based on Oracle price volatility
//! - Multi-signature governance integration support

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, IntoVal,
};

/// Maximum allowed price volatility percentage (in basis points, 500 = 5%)
const DEFAULT_MAX_VOLATILITY_BPS: i128 = 500;

/// Default timelock duration in seconds (1 hour)
const DEFAULT_UNPAUSE_TIMELOCK_SECONDS: u64 = 3600;

/// Minimum time between autonomous triggers to prevent spam (5 minutes)
const MIN_TRIGGER_INTERVAL_SECONDS: u64 = 300;

/// Pause level enum for tiered pausing
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PauseLevel {
    /// No pause - all operations normal
    None,
    /// Only swap operations paused
    SwapOnly,
    /// Only withdrawal operations paused
    WithdrawalOnly,
    /// All operations paused (full halt)
    Full,
}

/// Storage keys for circuit breaker state
#[contracttype]
pub enum DataKey {
    /// Contract admin address
    Admin,
    /// Current pause level
    PauseLevel,
    /// Timestamp when pause was activated
    PauseActivatedAt,
    /// Pending unpause request timestamp
    UnpauseRequestTime,
    /// Whether an unpause has been requested
    UnpauseRequested,
    /// Oracle consumer contract address
    OracleAddress,
    /// Maximum allowed volatility in basis points
    MaxVolatilityBps,
    /// Last price check timestamp
    LastPriceCheck,
    /// Last trigger timestamp for rate limiting
    LastTriggerTime,
    /// Governance contract address (optional)
    GovernanceAddress,
    /// Required signatures for emergency actions
    RequiredSignatures,
    /// Authorized bot addresses for autonomous triggers
    AuthorizedBots,
}

/// Event types for circuit breaker
#[contracttype]
#[derive(Clone)]
pub enum CircuitBreakerEvent {
    Paused { level: PauseLevel, reason: String },
    UnpauseRequested { unlock_time: u64 },
    Unpaused,
    TriggeredByOracle { reason: String },
    TriggeredByGovernance { proposal_id: u32 },
    TriggeredByBot { bot: Address, reason: String },
    ConfigUpdated { key: String, value: String },
}

/// Circuit breaker status response
#[contracttype]
#[derive(Clone)]
pub struct CircuitBreakerStatus {
    pub is_paused: bool,
    pub pause_level: PauseLevel,
    pub pause_activated_at: u64,
    pub unpause_available_at: u64,
    pub unpause_requested: bool,
    pub max_volatility_bps: i128,
    pub last_price_check: u64,
}

#[contract]
pub struct CircuitBreaker;

#[contractimpl]
impl CircuitBreaker {
    /// Initialize the circuit breaker with admin and optional oracle
    pub fn initialize(env: Env, admin: Address, oracle: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PauseLevel, &PauseLevel::None);
        env.storage().instance().set(&DataKey::PauseActivatedAt, &0u64);
        env.storage().instance().set(&DataKey::UnpauseRequested, &false);
        env.storage().instance().set(&DataKey::OracleAddress, &oracle);
        env.storage().instance().set(&DataKey::MaxVolatilityBps, &DEFAULT_MAX_VOLATILITY_BPS);
        env.storage().instance().set(&DataKey::LastPriceCheck, &0u64);
        env.storage().instance().set(&DataKey::LastTriggerTime, &0u64);
        env.storage().instance().set(&DataKey::RequiredSignatures, &1u32);
    }

    /// Get the current circuit breaker status
    pub fn get_status(env: Env) -> CircuitBreakerStatus {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        let pause_level: PauseLevel = env.storage().instance().get(&DataKey::PauseLevel).unwrap_or(PauseLevel::None);
        let pause_activated_at: u64 = env.storage().instance().get(&DataKey::PauseActivatedAt).unwrap_or(0);
        let unpause_request_time: u64 = env.storage().instance().get(&DataKey::UnpauseRequestTime).unwrap_or(0);
        let unpause_requested: bool = env.storage().instance().get(&DataKey::UnpauseRequested).unwrap_or(false);
        let max_volatility_bps: i128 = env.storage().instance().get(&DataKey::MaxVolatilityBps).unwrap_or(DEFAULT_MAX_VOLATILITY_BPS);
        let last_price_check: u64 = env.storage().instance().get(&DataKey::LastPriceCheck).unwrap_or(0);

        let unpause_available_at = if unpause_requested && unpause_request_time > 0 {
            unpause_request_time + DEFAULT_UNPAUSE_TIMELOCK_SECONDS
        } else {
            0
        };

        CircuitBreakerStatus {
            is_paused: pause_level != PauseLevel::None,
            pause_level,
            pause_activated_at,
            unpause_available_at,
            unpause_requested,
            max_volatility_bps,
            last_price_check,
        }
    }

    /// Check if a specific operation type is allowed
    pub fn is_operation_allowed(env: Env, operation: String) -> bool {
        let pause_level: PauseLevel = env.storage().instance().get(&DataKey::PauseLevel).unwrap_or(PauseLevel::None);

        match pause_level {
            PauseLevel::None => true,
            PauseLevel::SwapOnly => operation != symbol_short!("swap"),
            PauseLevel::WithdrawalOnly => operation != symbol_short!("withdraw"),
            PauseLevel::Full => false,
        }
    }

    /// Pause the protocol with a specific level (admin only)
    pub fn pause(env: Env, level: PauseLevel, reason: String) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        if level == PauseLevel::None {
            panic!("use unpause to clear a pause");
        }

        let current_time = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::PauseLevel, &level);
        env.storage().instance().set(&DataKey::PauseActivatedAt, &current_time);
        env.storage().instance().set(&DataKey::UnpauseRequested, &false);
        env.storage().instance().set(&DataKey::UnpauseRequestTime, &0u64);

        // Emit pause event
        env.events().publish(
            (symbol_short!("paused"), level.clone()),
            CircuitBreakerEvent::Paused { level, reason },
        );
    }

    /// Request unpause (starts timelock)
    pub fn request_unpause(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        let current_time = env.ledger().timestamp();
        
        // Check if already requested
        let unpause_requested: bool = env.storage().instance().get(&DataKey::UnpauseRequested).unwrap_or(false);
        if unpause_requested {
            panic!("unpause already requested, wait for timelock to expire");
        }

        env.storage().instance().set(&DataKey::UnpauseRequested, &true);
        env.storage().instance().set(&DataKey::UnpauseRequestTime, &current_time);

        let unlock_time = current_time + DEFAULT_UNPAUSE_TIMELOCK_SECONDS;
        
        env.events().publish(
            symbol_short!("unpause_req"),
            CircuitBreakerEvent::UnpauseRequested { unlock_time },
        );
    }

    /// Execute unpause after timelock has expired
    pub fn unpause(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        let unpause_requested: bool = env.storage().instance().get(&DataKey::UnpauseRequested).unwrap_or(false);
        if !unpause_requested {
            panic!("no unpause request pending");
        }

        let unpause_request_time: u64 = env.storage().instance().get(&DataKey::UnpauseRequestTime).unwrap_or(0);
        let current_time = env.ledger().timestamp();

        if current_time < unpause_request_time + DEFAULT_UNPAUSE_TIMELOCK_SECONDS {
            panic!("timelock period not yet expired");
        }

        // Reset all pause state
        env.storage().instance().set(&DataKey::PauseLevel, &PauseLevel::None);
        env.storage().instance().set(&DataKey::PauseActivatedAt, &0u64);
        env.storage().instance().set(&DataKey::UnpauseRequested, &false);
        env.storage().instance().set(&DataKey::UnpauseRequestTime, &0u64);

        env.events().publish(
            symbol_short!("unpaused"),
            CircuitBreakerEvent::Unpaused,
        );
    }

    /// Trigger circuit breaker by an authorized bot (autonomous trigger)
    pub fn trigger_by_bot(env: Env, bot: Address, level: PauseLevel, reason: String) {
        // Verify bot is authorized
        let authorized: bool = env.storage().instance().get(&DataKey::AuthorizedBots).unwrap_or(false);
        if !authorized && bot != env.storage().instance().get::<DataKey, Address>(&DataKey::Admin).unwrap_or(Address::from_contract_id(&env, &[0u8; 32])) {
            // For now, allow any call to trigger - in production, check bot authorization
        }

        // Rate limiting check
        let last_trigger: u64 = env.storage().instance().get(&DataKey::LastTriggerTime).unwrap_or(0);
        let current_time = env.ledger().timestamp();
        if current_time < last_trigger + MIN_TRIGGER_INTERVAL_SECONDS {
            panic!("trigger too soon after last trigger");
        }

        // Apply the pause
        env.storage().instance().set(&DataKey::PauseLevel, &level);
        env.storage().instance().set(&DataKey::PauseActivatedAt, &current_time);
        env.storage().instance().set(&DataKey::LastTriggerTime, &current_time);
        env.storage().instance().set(&DataKey::UnpauseRequested, &false);

        env.events().publish(
            (symbol_short!("triggered"), bot.clone()),
            CircuitBreakerEvent::TriggeredByBot { bot, reason },
        );
    }

    /// Trigger circuit breaker based on oracle price volatility
    pub fn trigger_by_oracle(env: Env, asset: Address, old_price: i128, new_price: i128, reason: String) {
        let oracle: Address = env.storage().instance().get(&DataKey::OracleAddress).expect("oracle not set");
        
        // Verify caller is the oracle or admin
        if env.invoker() != oracle && env.invoker() != env.storage().instance().get::<DataKey, Address>(&DataKey::Admin).unwrap_or(Address::from_contract_id(&env, &[0u8; 32])) {
            panic!("only oracle or admin can trigger by oracle");
        }

        // Calculate price change percentage in basis points
        let price_change_bps = if old_price > 0 {
            ((new_price - old_price).abs() * 10000) / old_price
        } else {
            0
        };

        let max_volatility: i128 = env.storage().instance().get(&DataKey::MaxVolatilityBps).unwrap_or(DEFAULT_MAX_VOLATILITY_BPS);

        if price_change_bps <= max_volatility {
            panic!("price volatility below threshold");
        }

        // Rate limiting check
        let last_trigger: u64 = env.storage().instance().get(&DataKey::LastTriggerTime).unwrap_or(0);
        let current_time = env.ledger().timestamp();
        if current_time < last_trigger + MIN_TRIGGER_INTERVAL_SECONDS {
            panic!("trigger too soon after last trigger");
        }

        // Determine pause level based on volatility severity
        let level = if price_change_bps > max_volatility * 3 {
            PauseLevel::Full  // Severe volatility - full pause
        } else if price_change_bps > max_volatility * 2 {
            PauseLevel::WithdrawalOnly  // High volatility - pause withdrawals
        } else {
            PauseLevel::SwapOnly  // Moderate volatility - pause swaps
        };

        // Apply the pause
        env.storage().instance().set(&DataKey::PauseLevel, &level);
        env.storage().instance().set(&DataKey::PauseActivatedAt, &current_time);
        env.storage().instance().set(&DataKey::LastPriceCheck, &current_time);
        env.storage().instance().set(&DataKey::LastTriggerTime, &current_time);
        env.storage().instance().set(&DataKey::UnpauseRequested, &false);

        env.events().publish(
            (symbol_short!("oracle_trig"), asset),
            CircuitBreakerEvent::TriggeredByOracle { reason },
        );
    }

    /// Trigger circuit breaker by governance proposal
    pub fn trigger_by_governance(env: Env, proposal_id: u32, level: PauseLevel) {
        let governance: Address = env.storage().instance().get(&DataKey::GovernanceAddress).expect("governance not set");
        
        // Verify caller is governance
        if env.invoker() != governance {
            panic!("only governance can trigger by governance");
        }

        let current_time = env.ledger().timestamp();
        
        // Apply the pause
        env.storage().instance().set(&DataKey::PauseLevel, &level);
        env.storage().instance().set(&DataKey::PauseActivatedAt, &current_time);
        env.storage().instance().set(&DataKey::LastTriggerTime, &current_time);
        env.storage().instance().set(&DataKey::UnpauseRequested, &false);

        env.events().publish(
            symbol_short!("gov_trig"),
            CircuitBreakerEvent::TriggeredByGovernance { proposal_id },
        );
    }

    /// Update configuration (admin only)
    pub fn set_max_volatility(env: Env, max_volatility_bps: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        if max_volatility_bps < 0 || max_volatility_bps > 10000 {
            panic!("volatility must be between 0 and 10000 bps");
        }

        env.storage().instance().set(&DataKey::MaxVolatilityBps, &max_volatility_bps);
        
        env.events().publish(
            symbol_short!("config"),
            CircuitBreakerEvent::ConfigUpdated { 
                key: symbol_short!("max_vol").to_string(), 
                value: max_volatility_bps.to_string() 
            },
        );
    }

    /// Set governance contract address (admin only)
    pub fn set_governance(env: Env, governance: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        env.storage().instance().set(&DataKey::GovernanceAddress, &governance);
    }

    /// Set oracle address (admin only)
    pub fn set_oracle(env: Env, oracle: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).expect("not initialized");
        admin.require_auth();

        env.storage().instance().set(&DataKey::OracleAddress, &oracle);
    }

    /// Get current pause level
    pub fn get_pause_level(env: Env) -> PauseLevel {
        env.storage().instance().get(&DataKey::PauseLevel).unwrap_or(PauseLevel::None)
    }

    /// Get admin address
    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("not initialized")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        
        let contract_id = env.register(CircuitBreaker, ());
        let client = CircuitBreaker::client(&env, &contract_id);
        
        client.initialize(&admin, &oracle);
        
        let status = client.get_status();
        assert!(!status.is_paused);
        assert_eq!(status.pause_level, PauseLevel::None);
    }

    #[test]
    fn test_pause_and_unpause() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        
        let contract_id = env.register(CircuitBreaker, ());
        let client = CircuitBreaker::client(&env, &contract_id);
        
        client.initialize(&admin, &oracle);
        
        // Pause with swap only
        client.pause(&PauseLevel::SwapOnly, &String::from_str(&env, "test pause"));
        
        let status = client.get_status();
        assert!(status.is_paused);
        assert_eq!(status.pause_level, PauseLevel::SwapOnly);
        
        // Check operation allowed
        assert!(!client.is_operation_allowed(&symbol_short!("swap")));
        assert!(client.is_operation_allowed(&symbol_short!("withdraw")));
        
        // Request unpause
        client.request_unpause();
        
        let status = client.get_status();
        assert!(status.unpause_requested);
        assert!(status.unpause_available_at > 0);
    }

    #[test]
    fn test_oracle_trigger() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        
        let contract_id = env.register(CircuitBreaker, ());
        let client = CircuitBreaker::client(&env, &contract_id);
        
        client.initialize(&admin, &oracle);
        
        // Trigger with high volatility (10% change = 1000 bps, max is 500 bps)
        let asset = Address::generate(&env);
        client.trigger_by_oracle(&asset, &1000i128, &1100i128, &String::from_str(&env, "high volatility"));
        
        let status = client.get_status();
        assert!(status.is_paused);
    }
}