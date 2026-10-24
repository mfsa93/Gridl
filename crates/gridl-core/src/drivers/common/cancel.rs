use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::future::{select, Either};

/// Resolves once `flag` is set. Cancels arrive from another task as a flag.
pub(crate) async fn raised(flag: &AtomicBool) {
    while !flag.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Runs `work` to the end. If `cancel` is raised first, `stop` runs (it asks
/// the server to interrupt the statement) and `work` then finishes on its own.
/// Returns the outcome and whether `stop` ran.
pub(crate) async fn interruptible<T>(
    work: impl Future<Output = T>,
    cancel: &AtomicBool,
    stop: impl Future<Output = ()>,
) -> (T, bool) {
    let watch = async {
        raised(cancel).await;
        stop.await;
    };
    futures_util::pin_mut!(work, watch);
    match select(work, watch).await {
        Either::Left((outcome, _)) => (outcome, false),
        Either::Right(((), work)) => (work.await, true),
    }
}

/// Runs `work` until it ends or `cancel` is raised, whichever comes first.
/// `None` means it was abandoned; for engines that stop a statement by
/// dropping it and then telling the server.
pub(crate) async fn abandonable<T>(
    work: impl Future<Output = T>,
    cancel: &AtomicBool,
) -> Option<T> {
    let watch = raised(cancel);
    futures_util::pin_mut!(work, watch);
    match select(work, watch).await {
        Either::Left((outcome, _)) => Some(outcome),
        Either::Right(((), _)) => None,
    }
}
