-- Two loops were renamed (Issue 2686, one word per thing): `settle` is the `checkpoints` loop, `fix-classes` the
-- `fix-causes` loop. Their last passes move to the new names, so a restart schedules them from there and the read of
-- factory.loop_passes (a name the code no longer has fails it) keeps working.
UPDATE factory.loop_passes SET loop = 'checkpoints' WHERE loop = 'settle';
UPDATE factory.loop_passes SET loop = 'fix-causes' WHERE loop = 'fix-classes';
