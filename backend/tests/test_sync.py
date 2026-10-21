from app.disputes.sync import disputes_to_fetch

LISTED = [
    {"dispute_id": "A", "update_time": "2026-10-21T10:00:00Z"},  # unchanged
    {"dispute_id": "B", "update_time": "2026-10-21T12:00:00Z"},  # updated since we stored it
    {"dispute_id": "C", "update_time": "2026-10-21T12:00:00Z"},  # brand new
]
SEEN = {"A": "2026-10-21T10:00:00Z", "B": "2026-10-21T09:00:00Z", "D": "2026-10-20T08:00:00Z"}


def test_manual_sync_fetches_only_new_or_changed():
    assert disputes_to_fetch(LISTED, SEEN, ["A", "D"], thorough=False) == ["B", "C"]


def test_background_poll_also_rechecks_every_open_dispute():
    assert disputes_to_fetch(LISTED, SEEN, ["A", "D"], thorough=True) == ["A", "B", "C", "D"]


def test_nothing_listed_means_nothing_to_fetch_on_manual_sync():
    assert disputes_to_fetch([], SEEN, ["A"], thorough=False) == []


def test_list_and_detail_timestamps_match_despite_different_precision():
    listed = [{"dispute_id": "A", "update_time": "2026-10-21T22:07:03.000Z"}]
    stored = {"A": "2026-10-21T22:07:03.929Z"}
    assert disputes_to_fetch(listed, stored, [], thorough=False) == []
