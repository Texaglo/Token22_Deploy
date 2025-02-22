use anyhow::{anyhow, Result};
use clap::Parser;
use log::{info, warn, debug};
use rayon::prelude::*;
use solana_program::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Instant,
};
use rand::Rng;
use serde_json;
use token22_vanity::VanityAddressResult;

mod metal;
use metal::MetalDevice;

const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Pattern to search for
    #[arg(short, long)]
    pattern: String,

    /// Position of pattern (start/end)
    #[arg(short, long)]
    position: String,

    /// Case insensitive search
    #[arg(short, long)]
    case_insensitive: bool,

    /// Number of CPU threads (default: num_cpus)
    #[arg(short, long)]
    threads: Option<usize>,

    /// Use GPU acceleration if available
    #[arg(short, long)]
    gpu: bool,
}

const TOKEN_PROGRAM_ID: Pubkey = solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const BATCH_SIZE: usize = 1_000_000;

#[derive(Clone)]
struct SearchStats {
    attempts: Arc<AtomicU64>,
    found: Arc<AtomicBool>,
}

impl SearchStats {
    fn new() -> Self {
        Self {
            attempts: Arc::new(AtomicU64::new(0)),
            found: Arc::new(AtomicBool::new(false)),
        }
    }
}

fn matches_pattern(address: &str, pattern: &str, case_insensitive: bool, position: &str) -> bool {
    let (address, pattern) = if case_insensitive {
        (address.to_lowercase(), pattern.to_lowercase())
    } else {
        (address.to_string(), pattern.to_string())
    };

    match position {
        "start" => address.starts_with(&pattern),
        "end" => address.ends_with(&pattern),
        _ => false,
    }
}

fn search_batch(
    base_keypair: &Keypair,
    pattern: &str,
    position: &str,
    case_insensitive: bool,
    stats: &SearchStats,
) -> Option<(String, Pubkey)> {
    if stats.found.load(Ordering::Relaxed) {
        return None;
    }

    debug!("Starting batch search with {} addresses", BATCH_SIZE);
    let mut seeds = Vec::with_capacity(BATCH_SIZE);
    let mut addresses = Vec::with_capacity(BATCH_SIZE);

    // Generate batch of random seeds
    for _ in 0..BATCH_SIZE {
        let mut rng = rand::thread_rng();
        let seed: String = (0..32)
            .map(|_| {
                let idx = rng.gen_range(0..CHARSET.len());
                CHARSET[idx] as char
            })
            .collect();
        seeds.push(seed);
    }
    debug!("Generated {} random seeds", seeds.len());

    // Create addresses in parallel
    addresses.par_extend(seeds.par_iter().filter_map(|seed| {
        match Pubkey::create_with_seed(
            &base_keypair.pubkey(),
            seed,
            &TOKEN_PROGRAM_ID,
        ) {
            Ok(address) => Some((seed.clone(), address)),
            Err(e) => {
                debug!("Error creating address with seed {}: {}", seed, e);
                None
            }
        }
    }));
    debug!("Created {} addresses", addresses.len());

    stats.attempts.fetch_add(BATCH_SIZE as u64, Ordering::Relaxed);

    // Check for matches
    for (seed, address) in addresses {
        if matches_pattern(
            &address.to_string(),
            pattern,
            case_insensitive,
            position,
        ) {
            debug!("Found matching address: {}", address);
            stats.found.store(true, Ordering::Relaxed);
            return Some((seed, address));
        }
    }

    None
}

#[cfg(feature = "gpu")]
mod gpu {
    use super::*;
    use crate::metal::MetalDevice;

    pub fn init_gpu() -> Result<MetalDevice> {
        MetalDevice::new()
    }

    pub fn search_gpu_batch(
        device: &MetalDevice,
        base_keypair: &Keypair,
        pattern: &str,
        position: &str,
        case_insensitive: bool,
        stats: &SearchStats,
    ) -> Option<(String, Pubkey)> {
        device.search_batch(base_keypair, pattern, position, case_insensitive, stats)
    }
}

fn main() -> Result<()> {
    env_logger::init();
    let args = Args::parse();

    if args.position != "start" && args.position != "end" {
        return Err(anyhow!("Position must be either 'start' or 'end'"));
    }

    info!("Starting vanity address search");
    debug!("Arguments: {:?}", args);

    let base_keypair = Keypair::new();
    let stats = SearchStats::new();
    let start_time = Instant::now();
    let num_threads = args.threads.unwrap_or_else(num_cpus::get);

    info!("Searching for pattern: {}", args.pattern);
    info!("Position: {}", args.position);
    info!("Case sensitive: {}", !args.case_insensitive);
    info!("Using {} threads", num_threads);

    // Initialize Metal device if GPU feature is enabled
    #[cfg(feature = "gpu")]
    let metal_device = if args.gpu {
        match gpu::init_gpu() {
            Ok(device) => {
                info!("Metal GPU acceleration enabled");
                Some(device)
            }
            Err(e) => {
                warn!("Failed to initialize Metal GPU: {}", e);
                warn!("Falling back to CPU");
                None
            }
        }
    } else {
        None
    };

    #[cfg(not(feature = "gpu"))]
    let metal_device: Option<MetalDevice> = None;

    if metal_device.is_none() {
        info!("Using {} CPU threads", num_threads);
        rayon::ThreadPoolBuilder::new()
            .num_threads(num_threads)
            .build_global()?;
    }

    let stats_clone = stats.clone();
    let attempts_clone = stats.attempts.clone();

    // Progress reporting thread
    std::thread::spawn(move || {
        let mut last_attempts = 0u64;
        let mut last_time = Instant::now();

        while !stats_clone.found.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let current_attempts = attempts_clone.load(Ordering::Relaxed);
            let attempts_delta = current_attempts - last_attempts;
            let time_delta = last_time.elapsed().as_secs_f64();
            
            info!(
                "Speed: {:.2}M attempts/s, Total: {}M attempts",
                attempts_delta as f64 / time_delta / 1_000_000.0,
                current_attempts / 1_000_000
            );

            last_attempts = current_attempts;
            last_time = Instant::now();
        }
    });

    // Main search loop
    loop {
        let result = if let Some(device) = metal_device.as_ref() {
            debug!("Using GPU for search batch");
            device.search_batch(
                &base_keypair,
                &args.pattern,
                &args.position,
                args.case_insensitive,
                &stats,
            )
        } else {
            debug!("Using CPU for search batch");
            search_batch(
                &base_keypair,
                &args.pattern,
                &args.position,
                args.case_insensitive,
                &stats,
            )
        };

        if let Some((seed, address)) = result {
            let elapsed = start_time.elapsed();
            let attempts = stats.attempts.load(Ordering::Relaxed);
            
            // Create the token address using the seed
            let token_address = Pubkey::create_with_seed(
                &base_keypair.pubkey(),
                &seed,
                &TOKEN_PROGRAM_ID,
            )?;

            // Verify the address matches what we found
            assert_eq!(token_address, address, "Token address mismatch!");
            
            // Print machine-readable output first
            println!("RESULT_START");
            println!("{{");
            println!("  \"base_pubkey\": \"{}\",", base_keypair.pubkey());
            println!("  \"seed\": \"{}\",", seed);
            println!("  \"token_address\": \"{}\",", token_address);
            println!("  \"time_taken\": {},", elapsed.as_secs_f64());
            println!("  \"attempts\": {}", attempts);
            println!("}}");
            println!("RESULT_END");
            
            // Then print human-readable output
            info!("Found matching address!");
            info!("Base pubkey: {}", base_keypair.pubkey());
            info!("Seed: {}", seed);
            info!("Token address: {}", token_address);
            info!("Time taken: {:.2}s", elapsed.as_secs_f64());
            info!(
                "Average speed: {:.2}M attempts/s",
                attempts as f64 / elapsed.as_secs_f64() / 1_000_000.0
            );
            
            // Save the keypair in Solana CLI format
            std::fs::create_dir_all("token_keys")?;
            let keypair_bytes = base_keypair.to_bytes();
            let keypair_str = format!("[{}]", keypair_bytes.iter().map(|b| b.to_string()).collect::<Vec<String>>().join(","));
            
            // Save only as token_keypair.json for TypeScript to rename
            std::fs::write("token_keys/token_keypair.json", &keypair_str)?;

            info!("Keypair saved to: token_keys/token_keypair.json");

            return Ok(());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pattern_matching() {
        assert!(matches_pattern("hello", "he", false, "start"));
        assert!(matches_pattern("hello", "lo", false, "end"));
        assert!(matches_pattern("Hello", "he", true, "start"));
        assert!(!matches_pattern("hello", "HE", false, "start"));
    }
} 