// Community interoperability patch: absence is the only recoverable store error.
// Never retain or format an error that may contain credential bytes or attributes.

pub(crate) const STORE_FAILURE: &str = "The operating-system credential store operation failed";

pub(crate) fn optional_credential<T>(
  result: keyring_core::Result<T>,
) -> std::result::Result<Option<T>, &'static str> {
  match result {
    Ok(value) => Ok(Some(value)),
    Err(keyring_core::Error::NoEntry) => Ok(None),
    Err(_) => Err(STORE_FAILURE),
  }
}

pub(crate) fn deleted_credential(
  result: keyring_core::Result<()>,
) -> std::result::Result<bool, &'static str> {
  optional_credential(result).map(|value| value.is_some())
}

#[cfg(test)]
mod tests {
  use super::*;
  use keyring_core::Error;

  fn store_failures() -> Vec<Error> {
    let sensitive = "sentinel-credential-data-not-for-diagnostics";
    vec![
      Error::PlatformFailure(Box::new(std::io::Error::other(sensitive))),
      Error::NoStorageAccess(Box::new(std::io::Error::other(sensitive))),
      Error::BadEncoding(sensitive.as_bytes().to_vec()),
      Error::BadDataFormat(
        sensitive.as_bytes().to_vec(),
        Box::new(std::io::Error::other(sensitive)),
      ),
      Error::BadStoreFormat(sensitive.into()),
      Error::TooLong(sensitive.into(), 1),
      Error::Invalid(sensitive.into(), sensitive.into()),
      Error::Ambiguous(vec![]),
      Error::NoDefaultStore,
      Error::NotSupportedByStore(sensitive.into()),
    ]
  }

  #[test]
  fn successful_empty_credentials_remain_present() {
    assert_eq!(optional_credential(Ok(String::new())), Ok(Some(String::new())));
    assert_eq!(optional_credential(Ok(Vec::<u8>::new())), Ok(Some(vec![])));
  }

  #[test]
  fn exact_no_entry_is_the_only_missing_read() {
    assert_eq!(optional_credential::<String>(Err(Error::NoEntry)), Ok(None));
    for error in store_failures() {
      assert_eq!(optional_credential::<String>(Err(error)), Err(STORE_FAILURE));
    }
  }

  #[test]
  fn successful_and_missing_deletion_are_distinct() {
    assert_eq!(deleted_credential(Ok(())), Ok(true));
    assert_eq!(deleted_credential(Err(Error::NoEntry)), Ok(false));
  }

  #[test]
  fn failed_deletion_is_never_a_successful_false() {
    for error in store_failures() {
      assert_eq!(deleted_credential(Err(error)), Err(STORE_FAILURE));
    }
  }

  #[test]
  fn secret_and_backend_details_do_not_escape_the_classifier() {
    for error in store_failures() {
      let public_error = optional_credential::<Vec<u8>>(Err(error)).unwrap_err();
      assert_eq!(public_error, STORE_FAILURE);
      assert!(!format!("{public_error:?}").contains("sentinel-credential-data"));
    }
  }
}
