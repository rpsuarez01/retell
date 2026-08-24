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
      'Caller Phone': call.from_number || '',
      'Route Type': custom.route_type || '',
      'Call Status': analysis.call_successful ? 'Completed' : 'Escalated',
      'Transcript': call.transcript || '',
    };

    const record = await airtableCreate(CALLS_TABLE, fields);
    console.log('Logged call to Airtable:', record.id);
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

    const record = await airtableCreate(BOOKINGS_TABLE, fields);

    // Optional: link this booking back to its Calls row, if the call_id was passed.
    if (args.call_id) {
      try {
        // Airtable doesn't support "find by field" in one call without a formula
        // filter; if you want this link written back automatically, add a
        // lookup-by-call-id step here using the Airtable list-records API with
        // a filterByFormula, then patch that record's "Linked Booking" field.
      } catch (linkErr) {
        console.error('Could not link booking to call:', linkErr);
      }
    }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Retell-Airtable bridge listening on port ${PORT}`));
