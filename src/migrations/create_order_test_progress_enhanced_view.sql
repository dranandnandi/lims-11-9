DROP VIEW IF EXISTS v_order_test_progress_enhanced CASCADE;

CREATE VIEW v_order_test_progress_enhanced AS
SELECT 
    o.id AS order_id,
    o.patient_id,
    o.patient_name,
    o.sample_id,
    o.status AS order_status,
    o.priority,
    o.order_date,
    o.created_at,
    o.sample_collected_at,
    COALESCE(o.sample_collected_at, o.created_at) AS work_date,
    o.lab_id,
    ot.id AS order_test_id,
    tg.id AS test_group_id,
    tg.name AS test_group_name,
    tg.department,
    tg.tat_hours,

    COUNT(DISTINCT tga.analyte_id) AS total_analytes,

    COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN tga.analyte_id END) AS completed_analytes,

    CASE
        WHEN COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN tga.analyte_id END) = 0
            THEN 'not_started'
        WHEN COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN tga.analyte_id END) 
             < COUNT(DISTINCT tga.analyte_id)
            THEN 'in_progress'
        ELSE 'completed'
    END AS panel_status,

    CASE
        WHEN COUNT(DISTINCT tga.analyte_id) > 0
            THEN ROUND(
                (COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN tga.analyte_id END)::numeric
                 / COUNT(DISTINCT tga.analyte_id)::numeric) * 100
            , 0)
        ELSE 0
    END AS completion_percentage,

    CASE
        WHEN COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN tga.analyte_id END) = 0
             AND EXISTS (
                SELECT 1
                FROM test_workflow_map m
                JOIN workflow_versions wv ON m.workflow_version_id = wv.id
                JOIN workflows w ON wv.workflow_id = w.id
                WHERE m.lab_id = o.lab_id
                  AND (m.test_group_id = tg.id OR m.test_code = tg.code::text)
                  AND COALESCE(w.active, true) = true
                  AND COALESCE(wv.active, true) = true
             )
            THEN true
        ELSE false
    END AS workflow_eligible,

    COUNT(DISTINCT CASE WHEN r.status = 'Entered' THEN r.id END) AS entered_count,
    COUNT(DISTINCT CASE WHEN r.status = 'Under Review' THEN r.id END) AS under_review_count,
    COUNT(DISTINCT CASE WHEN r.status = 'Approved' THEN r.id END) AS approved_count,
    COUNT(DISTINCT CASE WHEN r.status = 'Reported' THEN r.id END) AS reported_count,

    COUNT(DISTINCT CASE WHEN rv.flag::text = 'C' THEN r.id END) AS critical_count,
    COUNT(DISTINCT CASE 
        WHEN rv.flag::text IN ('H','L','C') THEN r.id 
    END) AS abnormal_count,

    GREATEST(
        o.created_at,
        COALESCE(MAX(r.entered_date)::timestamptz, o.created_at),
        COALESCE(MAX(r.reviewed_date)::timestamptz, o.created_at)
    ) AS last_activity,

    (EXTRACT(EPOCH FROM (now() - o.created_at)) / 3600)::numeric AS hours_since_order,

    CASE
        WHEN tg.tat_hours IS NOT NULL
            THEN tg.tat_hours - (EXTRACT(EPOCH FROM (now() - o.created_at)) / 3600)::numeric
        ELSE NULL
    END AS hours_until_tat_breach

FROM orders o
JOIN order_tests ot ON o.id = ot.order_id
JOIN test_groups tg ON ot.test_group_id = tg.id
LEFT JOIN test_group_analytes tga ON tg.id = tga.test_group_id
LEFT JOIN results r ON r.order_test_id = ot.id
LEFT JOIN result_values rv ON rv.result_id = r.id



GROUP BY 
    o.id, o.patient_id, o.patient_name, o.sample_id, 
    o.status, o.priority, o.order_date, o.created_at, 
    o.sample_collected_at, COALESCE(o.sample_collected_at, o.created_at),   -- ✅ added expression for work_date
    o.lab_id, ot.id, tg.id, tg.name, tg.department, tg.tat_hours

ORDER BY 
    CASE o.priority
        WHEN 'STAT' THEN 1
        WHEN 'Urgent' THEN 2
        ELSE 3
    END,
    o.order_date DESC;
