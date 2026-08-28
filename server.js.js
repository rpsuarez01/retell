require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const CALLS_TABLE = process.env.AIRTABLE_CALLS_TABLE || 'Calls';
const BOOKINGS_TABLE = process.env.AIRTABLE_BOOKINGS_TABLE || 'Bookings';

const AIRTABLE_URL = (table) =>
  `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;

async function airtableCreate(table, fields) {
  const res = await fetch(AIRTABLE_URL(table), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields, typecast: true }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Airtable create failed:', data);
    throw new Error(JSON.stringify(data));
  }
  return data;
}

async function airtableUpdate(table, recordId, fields) {
  const res = await fetch(`${AIRTABLE_URL(table)}/${recordId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields, typecast: true }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Airtable update failed:', data);
    throw new Error(JSON.stringify(data));
  }
  return data;
}

async function airtableFindByField(table, fieldName, value) {
  if (!value) return null;
  // Escape single quotes in the value for the formula string
  const safeValue = String(value).replace(/'/g, "\\'");
  const formula = `{${fieldName}} = '${safeValue}'`;
  const url = `${AIRTABLE_URL(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Airtable find failed:', data);
    return null;
  }
  return (data.records && data.records[0]) || null;
}

function digitsOnly(str) {
  return String(str || '').replace(/\D/g, '');
}

// Finds every prior booking matching a phone number, ignoring formatting
// differences (dashes, parens, spaces) on both sides of the comparison.
// Sorted newest-first so callers[0] is the most recent booking.
async function airtableFindAllByPhone(table, phoneFieldName, rawPhone) {
  const cleaned = digitsOnly(rawPhone);
  if (!cleaned) return [];
  const formula = `REGEX_REPLACE({${phoneFieldName}}, "[^0-9]", "") = '${cleaned}'`;
  const url =
    `${AIRTABLE_URL(table)}?filterByFormula=${encodeURIComponent(formula)}` +
    `&sort[0][field]=${encodeURIComponent('Appointment Date')}&sort[0][direction]=desc`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Airtable phone lookup failed:', data);
    return [];
  }
  return data.records || [];
}

// ---------------------------------------------------------------------------
// Endpoint 1: Retell's agent-level webhook (call_started / call_ended / call_analyzed)
// Set this URL as the agent's "Webhook URL" in Retell.
// Only acts on call_analyzed — that's when the transcript + post-call fields exist.
// ---------------------------------------------------------------------------
app.post('/webhook/retell/call', async (req, res) => {
  // Acknowledge fast — Retell retries if you take too long to respond.
  res.status(200).json({ received: true });

  try {
    const { event, call } = req.body;
    if (event !== 'call_analyzed') return;

    const analysis = call.call_analysis || {};
    const custom = analysis.custom_analysis_data || {};

    const fields = {
      'Call ID': call.call_id,
      'Timestamp': call.start_timestamp
        ? new Date(call.start_timestamp).toISOString()
        : new Date().toISOString(),
      'Caller Phone': custom.stated_phone_number || call.from_number || '',
      'Route Type': custom.route_type || '',
      'Call Status': analysis.call_successful ? 'Completed' : 'Escalated',
      'Transcript': call.transcript || '',
    };

    const record = await airtableCreate(CALLS_TABLE, fields);
    console.log('Logged call to Airtable:', record.id);

    // Try to find a booking created during this same call, and link the two
    // records both ways. The Bookings table needs a plain text "Call ID"
    // field (not a Link field) for this lookup to work.
    try {
      const bookingRecord = await airtableFindByField(BOOKINGS_TABLE, 'Call ID', call.call_id);
      if (bookingRecord) {
        await airtableUpdate(CALLS_TABLE, record.id, {
          'Linked Booking': [bookingRecord.id],
        });
        await airtableUpdate(BOOKINGS_TABLE, bookingRecord.id, {
          'Linked Call': [record.id],
        });
        console.log('Linked call', record.id, 'to booking', bookingRecord.id);
      } else {
        console.log('No matching booking found yet for call', call.call_id, '- skipping link.');
      }
    } catch (linkErr) {
      console.error('Error linking call to booking:', linkErr);
    }
  } catch (err) {
    console.error('Error handling call_analyzed webhook:', err);
  }
});

// ---------------------------------------------------------------------------
// Endpoint 2: Retell's create_booking Custom Function target.
// Set this URL as the function's endpoint in Retell's tool config.
// Fires mid-call, only once the agent has all required fields confirmed.
// ---------------------------------------------------------------------------
app.post('/webhook/retell/booking', async (req, res) => {
  try {
    // Retell sends custom function calls with the args under different shapes
    // depending on config version — handle both the flat and the nested case.
    const args = req.body.args || req.body;
    // Retell typically includes call metadata alongside the function args —
    // try the common locations for call_id so we can link this booking back
    // to its Calls row once the call ends.
    const callId = (req.body.call && req.body.call.call_id) || args.call_id || null;

    const fields = {
      'Customer Name': args.customer_name || '',
      'Phone': args.phone || '',
      'Service Address': args.service_address || '',
      'Owner/Tenant/Property Manager': args.owner_or_tenant || '',
      'New/Existing Customer': args.new_or_existing_customer || '',
      'Equipment Type': args.equipment_type || '',
      'Brand': args.brand || '',
      'Age': args.equipment_age || '',
      'Problem Description': args.problem_description || '',
      'Symptom Details': args.symptom_details || '',
      'Onset/Duration': args.onset_duration || '',
      'Prior Troubleshooting': args.prior_troubleshooting || '',
      'Vulnerable Occupant': !!args.vulnerable_occupant,
      'Priority Level': args.priority_level || '',
      'Access Notes': args.access_notes || '',
      'Appointment Date': args.appointment_date || '',
      'Appointment Window': args.appointment_window || '',
      'Booking Status': 'Confirmed',
    };
    if (callId) {
      fields['Call ID'] = callId;
    }

    const record = await airtableCreate(BOOKINGS_TABLE, fields);
    console.log('Created booking', record.id, callId ? `for call ${callId}` : '(no call_id received)');

    // Respond in the shape Retell expects for a function result so the agent
    // can confirm the booking out loud.
    res.status(200).json({
      success: true,
      booking_id: record.id,
      message: 'Booking created successfully.',
    });
  } catch (err) {
    console.error('Error handling create_booking webhook:', err);
    res.status(500).json({ success: false, message: 'Failed to create booking.' });
  }
});

app.get('/health', (req, res) => res.status(200).send('ok'));

// ---------------------------------------------------------------------------
// Endpoint 3: Retell's lookup_customer Custom Function target.
// Call this right after the phone number is collected, early in the intake
// flow. It searches Bookings for any prior record on this phone number so
// the agent knows whether this is a new customer, a returning one, and
// whether this call might be about an appointment that already exists.
// ---------------------------------------------------------------------------
app.post('/webhook/retell/lookup-customer', async (req, res) => {
  try {
    const args = req.body.args || req.body;
    const phone = args.phone;

    if (!phone) {
      return res.status(200).json({
        found: false,
        message: 'No phone number provided to look up.',
      });
    }

    const matches = await airtableFindAllByPhone(BOOKINGS_TABLE, 'Phone', phone);

    if (matches.length === 0) {
      return res.status(200).json({
        found: false,
        is_new_customer: true,
        message: 'No prior bookings found for this phone number — treat as a new customer.',
      });
    }

    const mostRecent = matches[0].fields;
    return res.status(200).json({
      found: true,
      is_new_customer: false,
      prior_booking_count: matches.length,
      most_recent_customer_name: mostRecent['Customer Name'] || '',
      most_recent_service_address: mostRecent['Service Address'] || '',
      most_recent_appointment_date: mostRecent['Appointment Date'] || '',
      most_recent_booking_status: mostRecent['Booking Status'] || '',
      message:
        'This phone number has prior bookings. Ask the caller whether this call is about ' +
        'the existing appointment shown, or a new, separate issue, before proceeding.',
    });
  } catch (err) {
    console.error('Error handling lookup_customer webhook:', err);
    res.status(500).json({ found: false, message: 'Lookup failed — treat as unknown/new customer.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Retell-Airtable bridge listening on port ${PORT}`));
