-- Install once in a durable PostgreSQL database owned by the template operator.
CREATE SCHEMA IF NOT EXISTS rd_keywords;

CREATE TABLE IF NOT EXISTS rd_keywords.operations (
    account text NOT NULL,
    request_key text NOT NULL,
    admitted_day date NOT NULL,
    execution_id text NOT NULL,
    amount numeric NOT NULL CHECK (amount >= 0 AND amount < 'Infinity'::numeric),
    state text NOT NULL CHECK (state IN ('held', 'settled', 'released')),
    sheet_row jsonb,
    PRIMARY KEY (account, request_key)
);
CREATE INDEX IF NOT EXISTS operations_day
    ON rd_keywords.operations (account, admitted_day);

CREATE OR REPLACE FUNCTION rd_keywords.reserve(
    p_account text, p_key text, p_execution text, p_estimate numeric, p_cap numeric
) RETURNS TABLE (decision text, cached_row jsonb)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    prior rd_keywords.operations%ROWTYPE;
    today date;
    allocated numeric;
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Use READ COMMITTED for budget transactions';
    END IF;
    IF nullif(trim(p_account), '') IS NULL OR nullif(trim(p_execution), '') IS NULL
       OR p_key IS NULL OR p_key !~ '^rdn8n-keywords-[0-9a-f]{64}$'
       OR p_estimate IS NULL OR NOT (p_estimate >= 0 AND p_estimate < 'Infinity'::numeric)
       OR p_cap IS NULL OR NOT (p_cap >= 0 AND p_cap < 'Infinity'::numeric) THEN
        RAISE EXCEPTION 'Invalid reservation input';
    END IF;
    -- Serializes both admission and receipt updates for this billing account.
    PERFORM pg_advisory_xact_lock(hashtextextended('rd_keywords:' || p_account, 0));
    today := (clock_timestamp() AT TIME ZONE 'UTC')::date;
    SELECT * INTO prior FROM rd_keywords.operations
        WHERE account = p_account AND request_key = p_key;
    IF FOUND AND prior.state <> 'released' THEN
        RETURN QUERY SELECT prior.state, prior.sheet_row;
        RETURN;
    END IF;
    SELECT coalesce(sum(amount), 0) INTO allocated FROM rd_keywords.operations
        WHERE account = p_account AND admitted_day = today;
    IF allocated + p_estimate > p_cap THEN
        RETURN QUERY SELECT 'cap'::text, NULL::jsonb;
        RETURN;
    END IF;
    INSERT INTO rd_keywords.operations VALUES
        (p_account, p_key, today, p_execution, p_estimate, 'held', NULL)
    ON CONFLICT (account, request_key) DO UPDATE SET
        admitted_day = excluded.admitted_day, execution_id = excluded.execution_id,
        amount = excluded.amount, state = 'held', sheet_row = NULL;
    RETURN QUERY SELECT 'send'::text, NULL::jsonb;
END $$;

CREATE OR REPLACE FUNCTION rd_keywords.finish(
    p_account text, p_key text, p_execution text, p_state text, p_amount numeric, p_row jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('rd_keywords:' || p_account, 0));
    IF p_state IS NULL OR p_state NOT IN ('settled','released','held') OR p_row IS NULL
       OR (p_state = 'settled' AND (p_amount IS NULL OR NOT (p_amount >= 0 AND p_amount < 'Infinity'::numeric))) THEN
        RAISE EXCEPTION 'Invalid receipt';
    END IF;
    UPDATE rd_keywords.operations SET state = p_state,
        amount = CASE p_state WHEN 'settled' THEN p_amount WHEN 'released' THEN 0 ELSE amount END,
        sheet_row = p_row
    WHERE account = p_account AND request_key = p_key AND execution_id = p_execution AND state = 'held';
    IF NOT FOUND THEN RAISE EXCEPTION 'Reservation missing, closed, or owned by another execution'; END IF;
    RETURN p_row;
END $$;
