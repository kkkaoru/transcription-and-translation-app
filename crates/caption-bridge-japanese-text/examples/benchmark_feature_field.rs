//! Microbenchmark for the allocation-free morphological feature-field parser.
//!
//! Run with:
//! `cargo run --release --manifest-path crates/caption-bridge-japanese-text/Cargo.toml --example benchmark_feature_field`

use std::hint::black_box;
use std::time::Instant;

use caption_bridge_japanese_text::{comma_separated_feature_field, is_japanese_kana_text};

const DEFAULT_ITERATIONS: usize = 20_000_000;
const ITERATIONS_ENV: &str = "KOTOBA_FEATURE_BENCH_ITERATIONS";
const KANA_FIELD_INDEX: usize = 20;
const QUOTED_UNIDIC_FEATURE: &str = "名詞,普通名詞,助数詞可能,*,*,*,ド,度,度,ド,度,ド,漢,*,*,*,*,*,\"B,B4WB7G9G\",体,ド,ド,ド,ド,0,C3,*,7407143582048768,26947";
const PLAIN_UNIDIC_FEATURE: &str = "名詞,数詞,*,*,*,*,ロクジュウ,六十,六十,ロクジュー,六十,ロクジュー,漢,*,*,十促,基本形,Nj,*,数,ロクジュウ,ロクジュウ,ロクジュウ,ロクジュウ,3,C2,*,11253518723850752,40940";

fn main() {
    let iterations = std::env::var(ITERATIONS_ENV)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|iterations| *iterations > 0)
        .unwrap_or(DEFAULT_ITERATIONS);

    assert_eq!(comma_separated_feature_field(QUOTED_UNIDIC_FEATURE, KANA_FIELD_INDEX), Some("ド"));
    assert_eq!(
        QUOTED_UNIDIC_FEATURE.split(',').nth(KANA_FIELD_INDEX),
        Some("体"),
        "the historical split parser must demonstrate the quoted-comma field shift"
    );
    assert_eq!(
        comma_separated_feature_field(PLAIN_UNIDIC_FEATURE, KANA_FIELD_INDEX),
        PLAIN_UNIDIC_FEATURE.split(',').nth(KANA_FIELD_INDEX)
    );

    benchmark_canonical_kana("quoted_canonical_kana", QUOTED_UNIDIC_FEATURE, iterations);
    benchmark_canonical_kana("plain_canonical_kana", PLAIN_UNIDIC_FEATURE, iterations);
    benchmark_split("plain_split_reference", PLAIN_UNIDIC_FEATURE, iterations);
}

fn benchmark_canonical_kana(label: &str, feature: &str, iterations: usize) {
    let started = Instant::now();
    let mut checksum = 0;
    for _ in 0..iterations {
        checksum += black_box(
            comma_separated_feature_field(black_box(feature), KANA_FIELD_INDEX)
                .filter(|field| is_japanese_kana_text(field)),
        )
        .unwrap_or("")
        .len();
    }
    print_result(label, iterations, started.elapsed().as_nanos(), checksum);
}

fn benchmark_split(label: &str, feature: &str, iterations: usize) {
    let started = Instant::now();
    let mut checksum = 0;
    for _ in 0..iterations {
        checksum +=
            black_box(black_box(feature).split(',').nth(KANA_FIELD_INDEX)).unwrap_or("").len();
    }
    print_result(label, iterations, started.elapsed().as_nanos(), checksum);
}

fn print_result(label: &str, iterations: usize, total_nanos: u128, checksum: usize) {
    let nanos_per_call = total_nanos / u128::try_from(iterations).unwrap_or(u128::MAX);
    println!(
        "{{\"benchmark\":\"{label}\",\"iterations\":{iterations},\"total_nanos\":{total_nanos},\"nanos_per_call\":{nanos_per_call},\"checksum\":{checksum}}}"
    );
}
