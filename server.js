require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json()); // Middleware to parse JSON bodies

const PORT = process.env.PORT || 3000;
const SHOPMONKEY_API_KEY = process.env.SHOPMONKEY_API_KEY;

if (!SHOPMONKEY_API_KEY) {
    console.error("FATAL ERROR: SHOPMONKEY_API_KEY is not defined in the .env file.");
    process.exit(1); // Exit the application if the key is missing
}

// --- Shopmonkey API Client with Static Bearer Token ---
// This is much simpler. It just adds the authorization header to every request.
const shopmonkeyApi = axios.create({
    baseURL: 'https://api.shopmonkey.io/v2',
    headers: {
        'Authorization': `Bearer ${SHOPMONKEY_API_KEY}`,
        'Accept': 'application/json'
    }
});


// --- Helper Functions ---

async function findOrCreateCustomer(phone, name) {
    const searchResponse = await shopmonkeyApi.get(`/customers?phone=${encodeURIComponent(phone)}&limit=1`);
    if (searchResponse.data && searchResponse.data.length > 0) {
        console.log(`Found existing customer ID: ${searchResponse.data[0].id}`);
        return searchResponse.data[0];
    }

    console.log(`Customer with phone ${phone} not found. Creating new one.`);
    const [firstName, ...lastNameParts] = name.split(' ');
    const createResponse = await shopmonkeyApi.post('/customers', {
        firstName: firstName || 'N/A',
        lastName: lastNameParts.join(' ') || 'N/A',
        phone: phone,
    });
    console.log(`Created new customer ID: ${createResponse.data.id}`);
    return createResponse.data;
}

async function findOrCreateVehicle(customerId, makeModel) {
     const searchResponse = await shopmonkeyApi.get(`/vehicles?customerId=${customerId}`);
    const existingVehicle = searchResponse.data.find(v => 
        `${v.make} ${v.model}`.toLowerCase().trim() === makeModel.toLowerCase().trim()
    );

    if (existingVehicle) {
        console.log(`Found existing vehicle ID: ${existingVehicle.id}`);
        return existingVehicle;
    }

    console.log(`Vehicle ${makeModel} not found for customer. Creating new one.`);
    const [make, ...modelParts] = makeModel.split(' ');
    const createResponse = await shopmonkeyApi.post('/vehicles', {
        customerId,
        make: make || 'Unknown',
        model: modelParts.join(' ') || 'Model',
    });
    console.log(`Created new vehicle ID: ${createResponse.data.id}`);
    return createResponse.data;
}


// --- API Endpoints for your AI Agent ---

app.post('/book-appointment', async (req, res) => {
    const { name, phone, makeModel, reason, dateTime } = req.body;
    if (!name || !phone || !makeModel || !reason || !dateTime) {
        return res.status(400).json({ status: 'failure', message: 'Client error: Missing required fields.' });
    }

    try {
        const customer = await findOrCreateCustomer(phone, name);
        const vehicle = await findOrCreateVehicle(customer.id, makeModel);

        await shopmonkeyApi.post('/appointments', {
            customerId: customer.id,
            vehicleId: vehicle.id,
            title: reason,
            startDateTime: dateTime, // Expects ISO 8601 format
        });
        
        const successMessage = `Appointment confirmed for ${name} regarding the ${makeModel}.`;
        console.log(`SUCCESS /book-appointment: ${successMessage}`);
        return res.status(201).json({ status: 'success', message: successMessage });

    } catch (error) {
        const errorDetails = error.response ? error.response.data : { message: error.message };
        console.error('ERROR /book-appointment:', JSON.stringify(errorDetails));

        // Check for a scheduling conflict or validation error
        if (error.response && (error.response.status === 409 || error.response.status === 422)) {
            return res.status(200).json({
                status: 'failure',
                message: 'That time slot is not available. Please suggest another time.'
            });
        }
        
        return res.status(500).json({ status: 'failure', message: 'An internal server error occurred.' });
    }
});


app.post('/check-status', async (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ status: 'failure', message: 'Client error: Missing phone number.' });
    }
    
    try {
        const customerSearch = await shopmonkeyApi.get(`/customers?phone=${encodeURIComponent(phone)}&limit=1`);
        if (!customerSearch.data || customerSearch.data.length === 0) {
            return res.status(200).json({ status: 'not_found', message: "I couldn't find a customer with that phone number." });
        }
        const customer = customerSearch.data[0];

        const ordersSearch = await shopmonkeyApi.get(`/orders?customerId=${customer.id}&isArchived=false`);
        if (!ordersSearch.data || ordersSearch.data.length === 0) {
            return res.status(200).json({ status: 'success', message: `I found customer ${customer.firstName}, but there are no active work orders for them.` });
        }
        
        const latestOrder = ordersSearch.data.sort((a, b) => new Date(b.updatedOn) - new Date(a.updatedOn))[0];
        const { vehicle, workflowStatus } = latestOrder;
        
        const responseMessage = `The status for the ${vehicle.year || ''} ${vehicle.make} ${vehicle.model} is currently '${workflowStatus.name}'.`;
        console.log(`SUCCESS /check-status: ${responseMessage}`);
        return res.status(200).json({ status: 'success', message: responseMessage });

    } catch (error) {
        const errorDetails = error.response ? error.response.data : { message: error.message };
        console.error('ERROR /check-status:', JSON.stringify(errorDetails));
        return res.status(500).json({ status: 'failure', message: 'An internal server error occurred.' });
    }
});


// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Shopmonkey Connector server running on http://localhost:${PORT}`);
    console.log('Ready to receive requests from the AI agent.');
});