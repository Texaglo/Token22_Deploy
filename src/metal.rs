use anyhow::{anyhow, Result};
use log::info;
use metal::*;
use objc::rc::autoreleasepool;
use solana_program::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

use crate::SearchStats;

const THREADS_PER_THREADGROUP: u64 = 256;
const NUM_THREADGROUPS: u64 = 1024;

// Metal shader code for address generation and pattern matching
const SHADER_SOURCE: &str = r#"
#include <metal_stdlib>
using namespace metal;

// Add missing standard library functions with proper address space qualifiers
inline void memcpy_metal(
    thread void* dest,
    const thread void* src,
    size_t n
) {
    thread char* d = (thread char*)dest;
    const thread char* s = (const thread char*)src;
    for (size_t i = 0; i < n; i++) {
        d[i] = s[i];
    }
}

// SHA256 implementation for Metal
constant uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    // ... rest of SHA256 constants ...
};

void sha256_metal(
    const thread uchar* input,
    uint length,
    thread uchar* output
) {
    uint32_t h0 = 0x6a09e667;
    uint32_t h1 = 0xbb67ae85;
    uint32_t h2 = 0x3c6ef372;
    uint32_t h3 = 0xa54ff53a;
    uint32_t h4 = 0x510e527f;
    uint32_t h5 = 0x9b05688c;
    uint32_t h6 = 0x1f83d9ab;
    uint32_t h7 = 0x5be0cd19;
    
    // For now, just copy input to output as placeholder
    memcpy_metal(output, input, 32);
}

// Base58 encoding for Metal
constant char BASE58_ALPHABET[] = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

void encode_base58(
    const thread uchar* data,
    uint length,
    thread char* result
) {
    // Simplified base58 encoding for testing
    // Just convert to hex for now
    for (uint i = 0; i < length; i++) {
        uint byte = data[i];
        result[i * 2] = BASE58_ALPHABET[byte >> 4];
        result[i * 2 + 1] = BASE58_ALPHABET[byte & 0xF];
    }
    result[length * 2] = 0; // Null terminator
}

struct SearchParams {
    device const uchar* base_pubkey;
    device const uchar* pattern;
    uint pattern_length;
    bool case_insensitive;
    bool match_end;
    device uchar* result_seed;
    device atomic_bool* found;
    device atomic_uint* attempts;
};

// Helper function to convert to lowercase
char to_lower(char c) {
    return (c >= 'A' && c <= 'Z') ? c + ('a' - 'A') : c;
}

// Pattern matching functions
bool check_pattern_end(
    const thread char* address,
    const device uchar* pattern,
    uint pattern_length,
    bool case_insensitive
) {
    uint addr_len = 0;
    while (address[addr_len]) addr_len++;
    
    if (addr_len < pattern_length) return false;
    
    for (uint i = 0; i < pattern_length; i++) {
        char addr_char = address[addr_len - pattern_length + i];
        char pattern_char = pattern[i];
        
        if (case_insensitive) {
            addr_char = to_lower(addr_char);
            pattern_char = to_lower(pattern_char);
        }
        
        if (addr_char != pattern_char) return false;
    }
    
    return true;
}

bool check_pattern_start(
    const thread char* address,
    const device uchar* pattern,
    uint pattern_length,
    bool case_insensitive
) {
    for (uint i = 0; i < pattern_length; i++) {
        char addr_char = address[i];
        char pattern_char = pattern[i];
        
        if (case_insensitive) {
            addr_char = to_lower(addr_char);
            pattern_char = to_lower(pattern_char);
        }
        
        if (addr_char != pattern_char) return false;
    }
    
    return true;
}

kernel void search_addresses(
    device const SearchParams& params [[buffer(0)]],
    uint thread_position_in_grid [[thread_position_in_grid]]
) {
    if (atomic_load_explicit(params.found, memory_order_relaxed)) {
        return;
    }
    
    // Generate random seed (8 hex chars = 4 bytes)
    thread uchar seed[4];
    for (uint i = 0; i < 4; i++) {
        seed[i] = (uchar)((thread_position_in_grid + i) % 256);
    }
    
    // Convert seed to hex string
    thread char seed_hex[8];
    for (uint i = 0; i < 4; i++) {
        uint byte = seed[i];
        seed_hex[i * 2] = "0123456789abcdef"[byte >> 4];
        seed_hex[i * 2 + 1] = "0123456789abcdef"[byte & 0xF];
    }
    
    // Generate address using CreateWithSeed algorithm
    thread uchar buffer[128];
    memcpy_metal(buffer, params.base_pubkey, 32);
    memcpy_metal(buffer + 32, seed_hex, 8);
    
    // Add Token-2022 program ID
    const thread uchar TOKEN_PROGRAM_ID[] = {
        // Token-2022 program ID bytes
        0x54, 0x6F, 0x6B, 0x65, 0x6E, 0x7A, 0x51, 0x64,
        0x42, 0x4E, 0x62, 0x4C, 0x71, 0x50, 0x35, 0x56,
        0x45, 0x68, 0x64, 0x6B, 0x41, 0x53, 0x36, 0x45,
        0x50, 0x46, 0x4C, 0x43, 0x31, 0x50, 0x48, 0x6E
    };
    memcpy_metal(buffer + 64, TOKEN_PROGRAM_ID, 32);
    
    // Hash the buffer using SHA256
    thread uchar address[32];
    sha256_metal(buffer, 96, address);
    
    // Convert address to base58
    thread char base58_address[45];
    encode_base58(address, 32, base58_address);
    
    // Check if address matches pattern
    bool matches = params.match_end
        ? check_pattern_end(base58_address, params.pattern, params.pattern_length, params.case_insensitive)
        : check_pattern_start(base58_address, params.pattern, params.pattern_length, params.case_insensitive);
    
    atomic_fetch_add_explicit(params.attempts, 1, memory_order_relaxed);
    
    if (matches) {
        bool expected = false;
        if (atomic_compare_exchange_weak_explicit(
            params.found,
            &expected,
            true,
            memory_order_relaxed,
            memory_order_relaxed
        )) {
            // Copy seed to result buffer
            for (uint i = 0; i < 8; i++) {
                params.result_seed[i] = seed_hex[i];
            }
        }
    }
}
"#;

#[derive(Clone)]
pub struct MetalDevice {
    device: Device,
    command_queue: CommandQueue,
    pipeline_state: ComputePipelineState,
}

impl MetalDevice {
    pub fn new() -> Result<Self> {
        autoreleasepool(|| {
            let device = Device::system_default().ok_or_else(|| anyhow!("No Metal device found"))?;
            
            info!("Using Metal GPU: {}", device.name());
            
            let command_queue = device.new_command_queue();
            
            // Create compute pipeline
            let library = device.new_library_with_source(SHADER_SOURCE, &CompileOptions::new())
                .map_err(|e| anyhow!("Failed to create Metal library: {}", e))?;
            let kernel = library.get_function("search_addresses", None)
                .map_err(|e| anyhow!("Failed to get kernel function: {}", e))?;
            let pipeline_state = device.new_compute_pipeline_state_with_function(&kernel)
                .map_err(|e| anyhow!("Failed to create pipeline state: {}", e))?;
            
            Ok(Self {
                device,
                command_queue,
                pipeline_state,
            })
        })
    }

    pub fn search_batch(
        &self,
        base_keypair: &Keypair,
        pattern: &str,
        position: &str,
        case_insensitive: bool,
        stats: &SearchStats,
    ) -> Option<(String, Pubkey)> {
        autoreleasepool(|| {
            // Create buffers
            let base_pubkey = base_keypair.pubkey().to_bytes();
            let pattern_bytes = pattern.as_bytes();
            
            let base_buffer = self.device.new_buffer_with_data(
                base_pubkey.as_ptr() as *const _,
                base_pubkey.len() as u64,
                MTLResourceOptions::StorageModeShared,
            );
            
            let pattern_buffer = self.device.new_buffer_with_data(
                pattern_bytes.as_ptr() as *const _,
                pattern_bytes.len() as u64,
                MTLResourceOptions::StorageModeShared,
            );
            
            let result_buffer = self.device.new_buffer(
                32,
                MTLResourceOptions::StorageModeShared,
            );
            
            let found_buffer = self.device.new_buffer(
                std::mem::size_of::<bool>() as u64,
                MTLResourceOptions::StorageModeShared,
            );
            
            let attempts_buffer = self.device.new_buffer(
                std::mem::size_of::<u32>() as u64,
                MTLResourceOptions::StorageModeShared,
            );
            
            // Create command buffer and encoder
            let command_buffer = self.command_queue.new_command_buffer();
            let compute_encoder = command_buffer.new_compute_command_encoder();
            
            // Set pipeline and parameters
            compute_encoder.set_compute_pipeline_state(&self.pipeline_state);
            compute_encoder.set_buffer(0, Some(&base_buffer), 0);
            compute_encoder.set_buffer(1, Some(&pattern_buffer), 0);
            compute_encoder.set_buffer(2, Some(&result_buffer), 0);
            compute_encoder.set_buffer(3, Some(&found_buffer), 0);
            compute_encoder.set_buffer(4, Some(&attempts_buffer), 0);
            
            // Dispatch threads
            let threadgroup_size = MTLSize::new(THREADS_PER_THREADGROUP, 1, 1);
            let grid_size = MTLSize::new(THREADS_PER_THREADGROUP * NUM_THREADGROUPS, 1, 1);
            compute_encoder.dispatch_threads(grid_size, threadgroup_size);
            
            compute_encoder.end_encoding();
            command_buffer.commit();
            command_buffer.wait_until_completed();
            
            // Check results
            let found = unsafe {
                *(found_buffer.contents() as *const bool)
            };
            
            if found {
                let seed_bytes = unsafe {
                    std::slice::from_raw_parts(
                        result_buffer.contents() as *const u8,
                        32,
                    )
                };
                
                let seed = hex::encode(seed_bytes);
                let address = Pubkey::create_with_seed(
                    &base_keypair.pubkey(),
                    &seed,
                    &crate::TOKEN_PROGRAM_ID,
                ).unwrap();
                
                Some((seed, address))
            } else {
                None
            }
        })
    }
} 