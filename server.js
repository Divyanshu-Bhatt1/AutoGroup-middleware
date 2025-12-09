require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

// --- App Initialization & Middleware ---
const app = express();
app.use(express.json());
app.use(cors());

// --- Environment Variable Validation ---
const { PORT, SHOPMONKEY_API_KEY, LOCATION_ID } = process.env;
const SHOP_TIMEZONE = "America/Los_Angeles"; // IMPORTANT: Set this to your shop's timezone

if (!SHOPMONKEY_API_KEY || !LOCATION_ID) {
  console.error(
    "FATAL ERROR: SHOPMONKEY_API_KEY and LOCATION_ID must be defined in the .env file."
  );
  process.exit(1);
}

// --- Shopmonkey API Client (v3) ---
const shopmonkeyApi = axios.create({
  baseURL: "https://api.shopmonkey.cloud/v3",
  headers: {
    Authorization: `Bearer ${SHOPMONKEY_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// --- API Endpoints ---

// 1. fetch-customer-detail API
app.post("/fetch-customer-detail", async (req, res, next) => {
  const { phone } = req.body;

  console.log(`[INFO] /fetch-customer-detail called with phone: ${phone}`);

  if (!phone) {
    console.log("[ERROR] Missing phone number");
    return res.status(400).json({
      success: false,
      message: "Client error: Missing required field 'phone'.",
    });
  }

  try {
    const customer = await findCustomerByPhone(phone);

    if (!customer) {
      console.log(`[INFO] Customer not found for phone: ${phone}`);
      return res.status(404).json({
        success: false,
        message: "Customer not found.",
      });
    }

    const fullName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
    console.log(`[SUCCESS] Found customer: ${fullName} (${customer.id})`);

    return res.status(200).json({
      success: true,
      customerId: customer.id,
      name: fullName,
      phone: phone,
    });

  } catch (error) {
    console.error("[ERROR] /fetch-customer-detail failed:", error.message);

    // Handle Shopmonkey specific validation errors (e.g., invalid phone number)
    if (error.response && error.response.status === 400) {
      console.log("[INFO] Shopmonkey rejected the phone number (400). Returning 'Customer not found' to client.");
      return res.status(404).json({
        success: false,
        message: "Customer not found (Invalid Phone Number).",
      });
    }

    return next(error);
  }
});

// 2. check-availability API
// 2. check-availability API
app.post("/check-availability", async (req, res, next) => {
  const { startRange } = req.body;
  const durationMinutes = 30;

  console.time('check-availability-timer'); // Timer Start

  if (!startRange) {
    return res.status(400).json({
      success: false,
      message: "Missing required parameter 'startRange'.",
    });
  }

  try {
    const inputDate = new Date(startRange);

    // --- STEP 1: DETERMINE THE EXACT DAY IN SHOP TIMEZONE ---
    // We break the input date down into "Shop Time" components to ensure we are targeting the right day.
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: SHOP_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    
    // This gives us "12/08/2025" regardless of whether input was UTC or PST
    const [{ value: month },,{ value: day },,{ value: year }] = formatter.formatToParts(inputDate);
    const shopDateString = `${year}-${month}-${day}`;

    console.log(`[DEBUG] Input: ${startRange}`);
    console.log(`[DEBUG] Shop Target Date: ${shopDateString} (${SHOP_TIMEZONE})`);

    // --- STEP 2: DEFINE SEARCH BOUNDARIES ---
    // We construct a window that definitely covers the Shop's day.
    // We simply search from 12:00 AM to 11:59 PM of that specific shop day.
    // Note: We interpret this string as if it's in the shop timezone by appending the input's offset or handling it in the loop.
    // A robust way to ensure we get the full UTC range for "Monday in LA":
    // 8 AM PST is approx 16:00 UTC. 
    // We will set our search cursor to a safe 'start' (Midnight UTC of requested day) and iterate sufficiently.
    
    // Simple approach: Use the input date, reset to 12:00 PM UTC, then scan +/- 18 hours.
    // This covers all timezone possibilities for a single day.
    const baseDate = new Date(startRange); 
    // Reset base to rough middle of day to avoid edge cases
    baseDate.setUTCHours(12, 0, 0, 0); 
    
    const searchLoopStart = new Date(baseDate.getTime() - 18 * 60 * 60 * 1000); // Look back 18h
    const searchLoopEnd = new Date(baseDate.getTime() + 18 * 60 * 60 * 1000);   // Look forward 18h

    console.log(`[DEBUG] Search Loop (UTC): ${searchLoopStart.toISOString()} to ${searchLoopEnd.toISOString()}`);

    // --- STEP 3: FETCH APPOINTMENTS (Only strictly for this window) ---
    // As per your request: No 24h buffer. Just what is in this window.
    const searchPayload = {
      where: {
        locationId: { _eq: LOCATION_ID },
        startDate: { gte: searchLoopStart.toISOString() },
        endDate: { lte: searchLoopEnd.toISOString() },
        status: { _neq: "Canceled" },
      },
      limit: 100,
    };

    const response = await shopmonkeyApi.post("/appointment/search", searchPayload);
    const existingAppointments = response.data.data || [];
    console.log(`[DEBUG] Found ${existingAppointments.length} existing appointments in this window.`);

    // --- STEP 4: GENERATE AND FILTER SLOTS ---
    const currentNow = new Date();
    const potentialSlots = [];
    
    let slotTime = new Date(searchLoopStart);
    // Align to nearest 30 min to be clean
    if(slotTime.getMinutes() > 30) slotTime.setMinutes(60,0,0);
    else if(slotTime.getMinutes() > 0) slotTime.setMinutes(30,0,0);

    // Loop through the wide window, but only keep slots that match the specific Shop Date and Hours
    while (slotTime < searchLoopEnd) {
      
      // 1. Convert Current Slot to Shop Details
      const shopTime = getShopTimeDetails(slotTime); 
      // Returns: { year: 2025, month: 12, day: 8, weekday: 1 (Mon), hour: 8, minute: 0 }
      
      // 2. CHECK: Is this slot actually on the requested day?
      // (This filters out Sunday night or Tuesday morning that might be in the buffer)
      // We compare YYYY-MM-DD
      const currentSlotDateString = `${shopTime.year}-${String(shopTime.month).padStart(2,'0')}-${String(shopTime.day).padStart(2,'0')}`;
      
      if (currentSlotDateString === shopDateString) {
        
        // 3. CHECK: Business Hours
        let isOpen = false;
        let openHour = 0;
        let openMinute = 0;
        let closeHour = 0;
        let closeMinute = 0;

        if (shopTime.weekday >= 1 && shopTime.weekday <= 5) { // Mon-Fri
          isOpen = true;
          openHour = 8;
          openMinute = 0;
          closeHour = 16;
          closeMinute = 30;
        } else if (shopTime.weekday === 6) { // Sat
          isOpen = true;
          openHour = 9;
          openMinute = 0;
          closeHour = 11;
          closeMinute = 0;
        }

        const slotMinutes = shopTime.hour * 60 + shopTime.minute;
        const openMinutes = openHour * 60 + openMinute;
        const closeMinutes = closeHour * 60 + closeMinute;

        if (isOpen && slotMinutes >= openMinutes && slotMinutes < closeMinutes) {
          
          const candidateStart = new Date(slotTime);
          const candidateEnd = new Date(candidateStart.getTime() + durationMinutes * 60000);
          let isValid = true;

          // 4. CHECK: Saturday 24h Notice
          if (shopTime.weekday === 6) {
            if ((candidateStart.getTime() - currentNow.getTime()) < (24 * 60 * 60 * 1000)) {
               // Optional: Log discarded Saturday slots
               // console.log(`[DEBUG] Discarded Sat Slot (Too soon): ${candidateStart.toISOString()}`);
               isValid = false;
            }
          }

          // 5. CHECK: Conflicts
          if (isValid) {
            const isOverlapping = existingAppointments.some((appt) => {
              const apptStart = new Date(appt.startDate);
              const apptEnd = new Date(appt.endDate);
              // Standard Overlap Logic
              return apptStart < candidateEnd && apptEnd > candidateStart;
            });

            if (isOverlapping) {
               // console.log(`[DEBUG] Slot Conflict: ${candidateStart.toISOString()}`);
               isValid = false;
            }
          }

          if (isValid) {
            potentialSlots.push(candidateStart);
          }
        }
      }

      // Increment 30 mins
      slotTime.setMinutes(slotTime.getMinutes() + 30);
    }

    const formattedSlots = potentialSlots.map((date) => {
      return {
        iso: date.toISOString(),
        readable: date.toLocaleString("en-US", {
          timeZone: SHOP_TIMEZONE,
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }),
      };
    });

    console.log(`[DEBUG] Final Available Slots Count: ${formattedSlots.length}`);
    console.timeEnd('check-availability-timer');

    res.status(200).json({
      success: true,
      message: `Found ${formattedSlots.length} available slots.`,
      availableSlots: formattedSlots,
    });

  } catch (error) {
    console.timeEnd('check-availability-timer');
    return next(error);
  }
});



// 3. booking API
app.post("/booking", async (req, res, next) => {
  const { phone, make, model, title, startDate, name } = req.body;
  const durationMinutes = 30; // Fixed default duration

  // Basic validation
  if (!phone || !make || !model || !title || !startDate || !name) {
    return res.status(400).json({
      success: false,
      message: "Client error: Missing required fields (phone, make, model, title, startDate, name).",
    });
  }

  // Date Validation
  const start = new Date(startDate);
  if (isNaN(start.getTime())) {
    return res.status(400).json({
      success: false,
      message: "Client error: 'startDate' is invalid. Please provide a valid ISO 8601 date string.",
    });
  }

  try {
    // --- Check for Availability (Double-Booking Prevention) ---
    const end = new Date(start.getTime() + durationMinutes * 60000);

    // Search window: +/- 24 hours to ensure we catch any overlapping appointments
    // We fetch a broader range and filter in memory to be 100% sure of overlaps.
    const searchStartWindow = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    const searchEndWindow = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const searchPayload = {
      where: {
        locationId: { _eq: LOCATION_ID },
        startDate: {
          gte: searchStartWindow.toISOString(),
          lte: searchEndWindow.toISOString()
        },
        status: { _neq: "Canceled" }
      },
      limit: 100, // Ensure we fetch enough appointments to find the conflict
    };

    console.log(`[INFO] Checking availability for: ${start.toISOString()} - ${end.toISOString()}`);

    const availabilityResponse = await shopmonkeyApi.post(
      "/appointment/search",
      searchPayload
    );

    const potentialConflicts = availabilityResponse.data.data || [];

    // Strict In-Memory Overlap Check
    const conflictingAppointment = potentialConflicts.find((appt) => {
      const apptStart = new Date(appt.startDate);
      const apptEnd = new Date(appt.endDate);

      // Check if this specific appointment overlaps with our requested slot
      // Overlap logic: (StartA < EndB) and (EndA > StartB)
      const isOverlapping = apptStart < end && apptEnd > start;

      if (isOverlapping) {
        console.log(`[DEBUG] Conflict found with Appt ID: ${appt.id} | Time: ${appt.startDate} - ${appt.endDate}`);
      }
      return isOverlapping;
    });

    if (conflictingAppointment) {
      console.log(`[WARN] Booking failed: Slot occupied by Appt ID ${conflictingAppointment.id}`);
      return res.status(409).json({ // 409 Conflict
        success: false,
        message: "The requested time slot is already booked. Please choose a different time.",
      });
    }

    // --- Customer & Vehicle Logic ---

    // 1. Find or Create Customer
    const { customerData, wasCreated: customerCreated } = await findOrCreateCustomer({ name, phone });

    // 2. Find or Create Vehicle
    // We use the customer ID to look for vehicles
    const { vehicleData, wasCreated: vehicleCreated } = await findOrCreateVehicle(customerData.id, { make, model });

    // --- Create Appointment ---

    // Format Title: Name / Make Model / Reason (Year removed)
    const vehicleString = `${vehicleData.make} ${vehicleData.model}`.trim();
    const appointmentTitle = `${customerData.firstName} ${customerData.lastName ? customerData.lastName[0] + '.' : ''} / ${vehicleString} / ${title}`;

    const appointmentPayload = {
      customerId: customerData.id,
      vehicleId: vehicleData.id,
      locationId: LOCATION_ID,
      name: appointmentTitle,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      color: "blue",
    };

    await shopmonkeyApi.post("/appointment", appointmentPayload);

    const localAppointmentTime = formatToShopTime(start);
    const successMessage = `Success! Appointment confirmed for ${name} with ${vehicleString} on ${localAppointmentTime}.`;

    console.log(`[SUCCESS] /booking: ${successMessage}`);

    return res.status(201).json({
      success: true,
      message: successMessage,
      details: {
        customer: customerCreated ? "Created New" : "Existing",
        vehicle: vehicleCreated ? "Created New" : "Existing",
        appointmentTime: localAppointmentTime
      }
    });

  } catch (error) {
    return next(error);
  }
});

// 4. verify-appointment API
app.post("/verify-appointment", async (req, res, next) => {
  const { phone, make, model, originalDate } = req.body;

  if (!phone || !make || !model || !originalDate) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: phone, make, model, originalDate.",
    });
  }

  try {
    const customer = await findCustomerByPhone(phone);
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found." });
    }

    const appointment = await findAppointmentByDate(customer.id, originalDate);
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found for this date." });
    }

    // Verify Vehicle
    const vehicle = await getVehicleById(appointment.vehicleId);
    if (!vehicle) {
      return res.status(404).json({ success: false, message: "Vehicle associated with appointment not found." });
    }

    const makeMatch = isFuzzyMatch(vehicle.data.make, make);
    const modelMatch = isFuzzyMatch(vehicle.data.model, model);

    if (!makeMatch || !modelMatch) {
      return res.status(404).json({
        success: false,
        message: "Appointment found, but vehicle details do not match."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Appointment verified.",
      appointment: {
        id: appointment.id,
        title: appointment.name,
        startDate: appointment.startDate,
        endDate: appointment.endDate,
        vehicle: `${vehicle.data.make} ${vehicle.data.model}`
      }
    });

  } catch (error) {
    return next(error);
  }
});

// 5. cancel-appointment API
app.post("/cancel-appointment", async (req, res, next) => {
  const { phone, originalDate } = req.body;

  if (!phone || !originalDate) {
    return res.status(400).json({ success: false, message: "Missing required fields: phone, originalDate." });
  }

  try {
    const customer = await findCustomerByPhone(phone);
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });

    const appointment = await findAppointmentByDate(customer.id, originalDate);
    if (!appointment) return res.status(404).json({ success: false, message: "Appointment not found." });

    // Delete the appointment from Shopmonkey (provide empty body to satisfy content-type header requirement)
    await shopmonkeyApi.delete(`/appointment/${appointment.id}`, { data: {} });

    return res.status(200).json({ success: true, message: "Appointment deleted successfully." });
  } catch (error) {
    return next(error);
  }
});

// 6. update-appointment API
app.post("/update-appointment", async (req, res, next) => {
  const { phone, originalDate, newDate } = req.body;
  const durationMinutes = 30;

  if (!phone || !originalDate || !newDate) {
    return res.status(400).json({ success: false, message: "Missing required fields: phone, originalDate, newDate." });
  }

  try {
    const customer = await findCustomerByPhone(phone);
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });

    const appointment = await findAppointmentByDate(customer.id, originalDate);
    if (!appointment) return res.status(404).json({ success: false, message: "Appointment not found." });

    // Check availability for newDate
    const start = new Date(newDate);
    if (isNaN(start.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid newDate format." });
    }
    const end = new Date(start.getTime() + durationMinutes * 60000);

    // Check for conflicts (excluding current appointment)
    const isSlotAvailable = await checkSlotAvailability(start, end, appointment.id);
    if (!isSlotAvailable) {
      return res.status(409).json({ success: false, message: "The new time slot is already booked." });
    }

    await shopmonkeyApi.put(`/appointment/${appointment.id}`, {
      startDate: start.toISOString(),
      endDate: end.toISOString()
    });

    return res.status(200).json({ success: true, message: "Appointment updated successfully." });
  } catch (error) {
    return next(error);
  }
});

// 7. identify-caller API
app.post("/identify-caller", async (req, res, next) => {
  const { phone } = req.body;
console.time("identify-caller-duration");
  if (!phone) {
    return res.status(400).json({ found: false, message: "Missing phone number." });
  }

  try {
    // --- Step 1: Customer Lookup (Fail Fast) ---
    const e164Phone = normalizeToE164(phone);
    console.log("prev ",phone," next ",e164Phone)
    // Explicitly using limit: 1 as requested for optimization
    const customerSearchPayload = {
      phoneNumbers: [{ number: e164Phone }]
    };
    console.time("phone-lookup");
    const customerRes = await shopmonkeyApi.post("/customer/phone_number/search", customerSearchPayload);
    const customers = customerRes.data.data || [];

    console.timeEnd("phone-lookup");
    if (customers.length === 0) {
      console.timeEnd("identify-caller-duration");
      return res.status(200).json({ found: false });
    }

    const customer = customers[0];
    const customerId = customer.id;
    // --- Step 2: Context Retrieval (Parallel) ---

    // User requested strict future check: "only if the appointment time has not already passed."
    // We use current UTC time for comparison.
    const nowISO = new Date().toISOString();

    const [ordersRes, appointmentsRes] = await Promise.all([
      // Query A: Active Orders (Get all, filter later)
      shopmonkeyApi.get(`/customer/${customerId}/order`, {
        params: {
          orderBy: 'updatedDate DESC',
          limit: 1,
          where:JSON.stringify({
             archived: false,
          })
        }
      }),
      // Query B: Future Appointments (Strictly Future)
      shopmonkeyApi.post("/appointment/search", {
        where: {
          customerId: String(customerId),
          startDate: { gte: nowISO },
          status: { _neq: "Canceled" }
        },
        orderBy:{ startDate: "asc" },
        limit: 1
      })
    ]);

    // Handle Orders Response
    const allOrders = ordersRes.data.data || [];

    // In-Memory Filter for Active Orders
    // Updated Rule: Include ONLY status === "Estimate"
    // const activeOrders = allOrders.filter(order => order.status === "Estimate");
    const futureAppointments = appointmentsRes.data.data || [];

    // --- Step 3: Response Construction ---

    // Process Active Service
    let activeServiceObj = {
      exists: false,
      vehicle: null,
      status: null,
      orderId: null
    };

     const activeOrders = allOrders;


    if (activeOrders&&activeOrders.length>0) {
      const order = activeOrders[0];
      let vehicleName = "Unknown Vehicle";

     
        vehicleName = `${order.generatedVehicleName || 'Your Vehicle'}`.trim();
     
      

      activeServiceObj = {
        exists: true,
        vehicle: vehicleName,
        status: order.status,
        orderId: order.id
      };
    }

    // Process Future Appointment
    let futureAppointmentObj = {
      exists: false,
      vehicle: null,
      date: null
    };

    if (futureAppointments.length > 0) {
      const appt = futureAppointments[0];
      // Fetch vehicle details if not fully present in appointment object (often it's just an ID or partial)
      // For speed, strict requirements didn't say to fetch vehicle details if missing, 
      // but usually appointment objects have some vehicle info or we rely on what's there.
      // We'll map what we have. If vehicle data is sparse, we might return "Unknown".
      // Note: Appointment search often returns a 'vehicle' object or 'vehicleId'.
      // If we really need vehicle name and it's missing, we'd need another call, but that violates "Fail Fast/Minimal".
      // We will try to extract from 'vehicle' property if it exists, or description/title.
      let vehicleName = "Unknown Vehicle";
      if (appt.vehicle) {
        vehicleName = `${appt.vehicle.year || ''} ${appt.vehicle.make || ''} ${appt.vehicle.model || ''}`.trim();
      } else if (appt.name) {
        // Fallback: try to parse from name if we formulated it as "Customer / Vehicle / ..."
        const parts = appt.name.split('/');
        if (parts.length >= 2) vehicleName = parts[1].trim();
      }

      futureAppointmentObj = {
        exists: true,
        vehicle: vehicleName,
        date: appt.startDate
      };
    }

    console.timeEnd("identify-caller-duration");

    // Final Response
    return res.status(200).json({
      found: true,
      customer: {
        id: customer.id,
        name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
        phone:phone
      },
      activeService: activeServiceObj,
      futureAppointment: futureAppointmentObj
    });

  } catch (error) {
    console.timeEnd("identify-caller-duration");

    return next(error);
  }
});

// --- Centralized Error Handling Middleware ---
app.use((error, req, res, next) => {
  const errorDetails = error.response
    ? error.response.data
    : { message: error.message, code: "LOCAL_ERROR" };
  const statusCode = error.response ? error.response.status : 500;
  console.error(
    `[ERROR] Status: ${statusCode} | Path: ${req.path} | API Message: ${errorDetails.message || "No specific message from API."
    }`,
    errorDetails
  );

  if (statusCode === 403) {
    return res.status(500).json({ success: false, message: "API Authorization Forbidden. Check your API Key." });
  }

  return res
    .status(statusCode)
    .json({ success: false, message: errorDetails.message || "An internal server error occurred." });
});

// --- Helper Functions ---


/**
 * Breaks a UTC Date object down into the Shop's Local Timezone components.
 * Essential for validating 8:00 AM vs 4:30 PM accurately.
 */
function getShopTimeDetails(utcDate) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TIMEZONE,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });

  const parts = formatter.formatToParts(utcDate);
  const partMap = {};
  parts.forEach((p) => (partMap[p.type] = p.value));

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    year: parseInt(partMap.year, 10),
    month: parseInt(partMap.month, 10),
    day: parseInt(partMap.day, 10),
    weekday: dayMap[partMap.weekday],
    hour: parseInt(partMap.hour, 10) % 24,
    minute: parseInt(partMap.minute, 10),
  };
}

function formatToShopTime(utcDate) {
  return utcDate.toLocaleString("en-US", {
    timeZone: SHOP_TIMEZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function normalizeToE164(phone) {
  if (!phone) return "";
  let digitsOnly = phone.replace(/\D/g, "");
  if (digitsOnly.length === 10) {
    return `+1${digitsOnly}`;
  }
  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) {
    return `+${digitsOnly}`;
  }
  if (phone.trim().startsWith("+")) {
    return `+${digitsOnly}`;
  }
  return `+${digitsOnly}`;
}

// Levenshtein Distance for Fuzzy Matching
function levenshteinDistance(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(
            matrix[i][j - 1] + 1,   // insertion
            matrix[i - 1][j] + 1    // deletion
          )
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

function isFuzzyMatch(str1, str2) {
  if (!str1 || !str2) return false;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) return true;

  // Allow a small number of edits based on string length
  const maxEdits = Math.floor(Math.min(s1.length, s2.length) / 3);
  const dist = levenshteinDistance(s1, s2);

  return dist <= maxEdits;
}

async function findCustomerByPhone(phone) {
  const e164Phone = normalizeToE164(phone);
  const searchPayload = { phoneNumbers: [{ number: e164Phone }] };
  const searchResponse = await shopmonkeyApi.post(
    "/customer/phone_number/search",
    searchPayload
  );
  if (searchResponse.data.data && searchResponse.data.data.length > 0) {
    return searchResponse.data.data[0];
  }
  return null;
}

async function findOrCreateCustomer(customerInfo) {
  const { name, phone } = customerInfo;
  const existingCustomer = await findCustomerByPhone(phone);

  if (existingCustomer) {
    console.log(`[INFO] Found existing customer: ${existingCustomer.id}`);
    return {
      customerData: existingCustomer,
      wasCreated: false,
    };
  }

  console.log("[INFO] Creating new customer...");
  const e164Phone = normalizeToE164(phone);
  const [firstName, ...lastNameParts] = name.split(" ");

  const createPayload = {
    name: name,
    firstName: firstName || "N/A",
    lastName: lastNameParts.join(" ") || "",
    phoneNumbers: [{ number: e164Phone, primary: true }],
    customerType: "Customer",
    originLocationId: LOCATION_ID,
    locationIds: [LOCATION_ID],
  };

  const createResponse = await shopmonkeyApi.post("/customer", createPayload);
  return {
    customerData: createResponse.data.data,
    wasCreated: true,
  };
}

async function findOrCreateVehicle(customerId, vehicleDetails) {
  const { make, model } = vehicleDetails;

  // Fetch all vehicles for the customer
  const searchResponse = await shopmonkeyApi.get(
    `/customer/${customerId}/vehicle`
  );

  const vehicles = searchResponse.data.data || [];

  // Fuzzy search for matching vehicle
  const existingVehicle = vehicles.find((v) => {
    const makeMatch = isFuzzyMatch(v.make, make);
    const modelMatch = isFuzzyMatch(v.model, model);
    return makeMatch && modelMatch;
  });

  if (existingVehicle) {
    console.log(`[INFO] Found existing vehicle (Fuzzy Match): ${existingVehicle.id} - ${existingVehicle.make} ${existingVehicle.model}`);
    return { vehicleData: existingVehicle, wasCreated: false };
  }

  console.log("[INFO] Creating new vehicle...");
  const createPayload = {
    customerId,
    make,
    model,
    size: "LightDuty", // Default
  };

  const createResponse = await shopmonkeyApi.post("/vehicle", createPayload);
  return { vehicleData: createResponse.data.data, wasCreated: true };
}

async function findAppointmentByDate(customerId, dateString) {
  const targetDate = new Date(dateString);
  console.log(`[DEBUG] findAppointmentByDate: customerId=${customerId} (${typeof customerId})`);

  // Search for active appointments for this customer
  const searchPayload = {
    where: {
      customerId: String(customerId),
      status: { _neq: "Canceled" }
    },
    limit: 50
  };
  console.log(`[DEBUG] searchPayload:`, JSON.stringify(searchPayload, null, 2));

  const response = await shopmonkeyApi.post("/appointment/search", searchPayload);
  const appointments = response.data.data || [];

  return appointments.find(appt => {
    const apptStart = new Date(appt.startDate);
    // Allow a small tolerance (e.g., same minute) or strict equality
    // Using strict equality for now as per requirement to match "originalDate"
    return apptStart.toISOString() === targetDate.toISOString();
  });
}

async function getVehicleById(vehicleId) {
  try {
    const response = await shopmonkeyApi.get(`/vehicle/${vehicleId}`);
    return response.data;
  } catch (error) {
    console.error(`[ERROR] Failed to fetch vehicle ${vehicleId}:`, error.message);
    return null;
  }
}

async function checkSlotAvailability(start, end, excludeAppointmentId = null) {
  // Search window: +/- 24 hours
  const searchStartWindow = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const searchEndWindow = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const searchPayload = {
    where: {
      locationId: { _eq: LOCATION_ID },
      startDate: {
        gte: searchStartWindow.toISOString(),
        lte: searchEndWindow.toISOString()
      },
      status: { _neq: "Canceled" }
    },
    limit: 100,
  };

  const response = await shopmonkeyApi.post("/appointment/search", searchPayload);
  const potentialConflicts = response.data.data || [];

  const conflictingAppointment = potentialConflicts.find((appt) => {
    if (excludeAppointmentId && appt.id === excludeAppointmentId) return false;

    const apptStart = new Date(appt.startDate);
    const apptEnd = new Date(appt.endDate);

    // Overlap logic: (StartA < EndB) and (EndA > StartB)
    return apptStart < end && apptEnd > start;
  });

  return !conflictingAppointment;
}

// --- Start Server ---
app.listen(PORT || 3000, () => {
  console.log(
    `[INFO] Shopmonkey Connector server running on port ${PORT || 3000}`
  );
  console.log(`[INFO] Ready to receive requests.`);
});