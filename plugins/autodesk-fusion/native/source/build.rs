extern crate napi_build;

fn main() {
  napi_build::setup();
  // A stable install name prevents the absolute build directory from being
  // embedded in the distributed Mach-O module. Apply only to this cdylib.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    println!("cargo:rustc-link-arg-cdylib=-Wl,-install_name,@rpath/libnapi_keyring.dylib");
  }
}
