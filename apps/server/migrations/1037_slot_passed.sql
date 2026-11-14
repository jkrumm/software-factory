-- A waiter in the test-slot line that a smaller step was granted past: when that first happened and which step it was. After the
-- passing window (`FACTORY_SLOT_PASS_MIN`) nothing passes the waiter any more.
ALTER TABLE factory.capacity_slots ADD COLUMN passed_at timestamptz, ADD COLUMN passed_by text;
