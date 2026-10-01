-- A bounty somebody was unassigned from waits for a person to redraw it.
--
-- The draw sweep draws every open bounty whose window has closed and that
-- nobody holds. Unassigning creates exactly that, so on 30 September it
-- redrew #34, #35 and #36 within eight seconds of the unassigns - before
-- anybody could press Redraw, and using up the one-draw exclusion on a draw
-- nobody chose. Set by an unassign, cleared by the next real draw, and the
-- sweep leaves a bounty alone while it is set.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS awaiting_redraw BOOLEAN NOT NULL DEFAULT false;
