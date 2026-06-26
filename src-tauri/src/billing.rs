//! Billing (P2) — connect the signed-in user to a Dodo Payments subscription.
//!
//! The desktop holds **no payment secret**. "Upgrade" simply opens a Dodo
//! checkout link in the system browser, stamped with the user's email and Clerk
//! id. A Vercel webhook (server-side, holds the secrets) maps the resulting
//! subscription back to the user — **by `clerk_user_id` in metadata, not by
//! email** (Dodo doesn't guarantee unique emails) — and flips their plan in
//! Clerk `public_metadata`, which the desktop then reads via the existing OAuth
//! session (see `entitlement.rs` / `auth.rs`).

use crate::error::{AppError, AppResult};

/// Dodo product + checkout config. Built-in for now (the Test-Mode product).
/// Flip `CHECKOUT_BASE` to `https://checkout.dodopayments.com` for live.
const DODO_PRODUCT_ID: &str = "pdt_0Nhqpssz0QnxuP6LwaScq";
const CHECKOUT_BASE: &str = "https://test.checkout.dodopayments.com";
/// Where Dodo returns the buyer after checkout (a Vercel page for now; a desktop
/// deep-link can replace this once a custom scheme is registered).
const RETURN_URL: &str = "https://octopush.sh/?upgraded=1";

/// Build the Dodo static checkout link for the subscription, prefilling the
/// user's email (when known) and carrying their Clerk id as metadata
/// (`metadata_*` prefix on static links) so the webhook can map the subscription
/// to the right account.
pub fn checkout_url(email: Option<&str>, clerk_user_id: &str) -> String {
    let q = |k: &str, v: &str| format!("{}={}", k, urlencoding::encode(v));
    let mut params = vec![
        q("metadata_clerk_user_id", clerk_user_id),
        q("redirect_url", RETURN_URL),
    ];
    // Prefill email only when we have one — never emit an empty `email=`.
    if let Some(email) = email.filter(|e| !e.is_empty()) {
        params.insert(0, q("email", email));
    }
    format!("{}/buy/{}?{}", CHECKOUT_BASE, DODO_PRODUCT_ID, params.join("&"))
}

/// Checkout link for the currently signed-in user. Errors if signed out (you
/// can't subscribe without an account to attach the subscription to).
pub fn checkout_url_for_current_user() -> AppResult<String> {
    let (sub, email) = crate::auth::current_identity()
        .ok_or_else(|| AppError::Other("Sign in before upgrading.".into()))?;
    Ok(checkout_url(email.as_deref(), &sub))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_url_carries_product_email_and_clerk_id() {
        let url = checkout_url(Some("a+b@example.com"), "user_123");
        assert!(url.starts_with(&format!("{CHECKOUT_BASE}/buy/{DODO_PRODUCT_ID}?")));
        // email is URL-encoded (the '+' must not survive as a literal).
        assert!(url.contains("email=a%2Bb%40example.com"));
        // the Clerk id rides as metadata so the webhook maps by id, not email.
        assert!(url.contains("metadata_clerk_user_id=user_123"));
        assert!(url.contains("redirect_url=https%3A%2F%2F"));
    }

    #[test]
    fn checkout_url_omits_empty_email() {
        let none = checkout_url(None, "user_9");
        assert!(!none.contains("email="));
        assert!(none.contains("metadata_clerk_user_id=user_9"));
        // an empty string is treated the same as None.
        assert!(!checkout_url(Some(""), "user_9").contains("email="));
    }
}
