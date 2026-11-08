import { useCallback, useEffect, useState } from "react";
import { getFeedbackOwnerStatus } from "../lib/rpc";
import { fetchNewFeedbackCount } from "../lib/queries";

/**
 * Whether this account is the site's feedback owner.
 *
 * This is a *rendering* answer, exactly like `usePrograms().can()`: the server
 * decides it through `is_feedback_owner()`, and every read and management call
 * re-checks that predicate. A compromised browser cannot turn this true.
 *
 * `enabled` lets the account sheet ask only once it is open, so a member who
 * never touches the menu costs no extra request. A failure reads as "not the
 * owner" and is returned so the inbox gate can offer a retry instead of quietly
 * pretending the page does not exist. Once the answer is yes it also asks for
 * the `new` count that badges the inbox row; a member never pays for that read.
 */
export function useFeedbackOwner(enabled = true) {
  const [owner, setOwner] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [newCount, setNewCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const answer = await getFeedbackOwnerStatus();
    setOwner(answer.owner);
    setError(answer.error);
    if (answer.owner) {
      const counted = await fetchNewFeedbackCount();
      setNewCount(counted.error ? null : counted.count);
    } else {
      setNewCount(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { owner, loading, error, refresh, newCount };
}
