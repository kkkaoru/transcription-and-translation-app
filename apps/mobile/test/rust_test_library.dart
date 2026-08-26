import 'dart:io';

import 'package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart';
import 'package:kotoba_beacon_companion/src/rust/frb_generated.dart';

Future<void> initializeRustTestLibrary() => RustLib.init(
  externalLibrary: ExternalLibrary.open(
    Platform.isMacOS
        ? 'rust/target/debug/librust_lib_kotoba_beacon_companion.dylib'
        : Platform.isWindows
        ? 'rust/target/debug/rust_lib_kotoba_beacon_companion.dll'
        : 'rust/target/debug/librust_lib_kotoba_beacon_companion.so',
  ),
);
