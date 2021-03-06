var gpio = require('chip-gpio').Gpio;
var http = require('http');
var url = require('url');

var CONFIG = {
    DOORS: [ // Object position in array corresponds to door ID.
        {
            id: 0,
            lift_pin: 6,
            sensor_pin: 7,
            lockout: false,
            human_name: "Left Door",
            lift_ctl: {
                write: ''
            },
            sensor_ctl: {
                read: ''
            }
        }
    ],
    AUTHORIZED_KEYS: [{
        name: 'Totally Insecure',
        key: 'default',
        allowHosts: ['ALL'],
        denyHosts: ['NONE'],
        allowMethods: ['ALL'],
        denyMethods: ['NONE']
    }],
    RELAY_TRIP_TIME: 500, //Time (in ms) to trip relay)
    HTTP_PORT: 8080
};

parseConfig();

http.createServer(function(req, res) {

    if (req.method === "GET") {

        var call = url.parse(req.url, true);

        console.log("Called " + req.url + " for door number: " + call.query.id);

        // allow any origin to make API calls.
        res.setHeader('Access-Control-Allow-Origin', '*');

        processRequest(call.pathname, call.query.id, call.query.api_key, req, res);

    } else if (req.method === "POST") {

        // allow any origin to make API calls.
        res.setHeader('Access-Control-Allow-Origin', '*');

        var body = "";

        // Collect POST data from request stream and store it in the body variable
        // Also ensures that body is not too large.
        req.on('data', function(data) {
            body += data;
            if (body.length > 1e7) {
                body = "";
            }
        });

        // After request has completed, and body has been collected
        req.on('end', function() {

            // If no data was sent, or alternatively if the request entity was too large
            if (body.length === 0) {
                // Serve an error to the client and halt further processing.
                res.writeHead(400);
                res.end(JSON.stringify({
                    "error": "no data sent or request entity too large"
                }));
                return;
            }

            var data = {};

            // Attempt to parse the posted JSON
            try {
                data = JSON.parse(body);
            } catch (error) {
                // If the request JSON is malformed, return an error to the client and halt processing.
                res.writeHead(400);
                res.end(JSON.stringify({
                    "error": "malformed JSON supplied"
                }));
		return;
            }

            /* Now that basic consistency checks are completed, we can attempt to process the request.
             * No need to worry about undefined keys in the data object, because the various sanity and
             * authorization checks at the beginnning of the processRequest function will handle these appropriately. 
             */
            processRequest(data.method, data.door_id, data.api_key, req, res);
        });

    } else {
        res.writeHead(400);
        res.end(JSON.stringify({
            error: "method not implemented"
        }));
    }

}.bind({
    CONFIG: CONFIG
})).listen(CONFIG.HTTP_PORT);

function processRequest(method, doorId, api_key, req, res) {
    // Validate request: door ID must be a number, API method must be supplied, requested door must exist in config.
    if (!/^-?\d+\.?\d*$/.test(doorId) || typeof method === "undefined" || typeof CONFIG.DOORS[doorId] === "undefined" && method !== "/get/list") {
        res.writeHead(400);
        res.end(JSON.stringify({
            error: "bad request or door does not exist"
        }));
        return;
    }

    // Check supplied API key against authorized applications list
    if (!checkAuthorization(method, api_key, req)) {
        res.writeHead(403);
        res.end(JSON.stringify({
            error: "not authorized"
        }));
        return;
    }

    switch (method) {
        case "/get/state":
            res.writeHead(200);
            var state = {
                state: CONFIG.DOORS[doorId].sensor_ctl.read() == 1 ? 0 : 1, // flip so that 1 -> closed and 0 -> open
                lockout: CONFIG.DOORS[doorId].lockout
            };
            res.end(JSON.stringify(state));
            break;

        case "/get/list":
            res.writeHead(200);
            res.end(JSON.stringify({
                list: strip_gpioCtl(CONFIG.DOORS)
            }));
            break;

        case "/set/open": // Open door ONLY if door currently closed. 
            res.writeHead(200);
            res.end(JSON.stringify({
                command_sent: !CONFIG.DOORS[doorId].lockout //inverse of lockout state determines if command sent, therefore if not locked then cmd is sent
            }));
            tripCircuit(doorId, 0, false);
            break;

        case "/set/close": // Close door ONLY if door currently open.
            res.writeHead(200);
            res.end(JSON.stringify({
                command_sent: !CONFIG.DOORS[doorId].lockout
            }));
            tripCircuit(doorId, 1, false);
            break;

        case "/set/cycle": // Cycle door state by sending command regardless of sensor reading
            res.writeHead(200);
            res.end(JSON.stringify({
                command_sent: !CONFIG.DOORS[doorId].lockout
            }));
            tripCircuit(doorId, null, true);
            break;

        case "/set/lockout": // Closes door and disables DoorControl API
            res.writeHead(200);
            res.end(JSON.stringify({
                command_sent: !CONFIG.DOORS[doorId].lockout
            }));
            tripCircuit(doorId, 1, false);
            CONFIG.DOORS[doorId].lockout = true; // set lockout flag
            break;

        default:
            res.writeHead(400);
            res.end(JSON.stringify({
                error: "method not implemented"
            }));
    }

    console.log("Completed method " + method + " for door ID " + doorId + " with key: " + api_key);
}

// Parses configuration object, configures GPIO control for each door programmatically. 
// Also sets default GPIO state
function parseConfig() {
    // Instantiate GPIO controller for each door and attach this to the door object.
    for (var i = 0; i < CONFIG.DOORS.length; i++) {
        CONFIG.DOORS[i].lift_ctl = new gpio(CONFIG.DOORS[i].lift_pin, 'high');
        CONFIG.DOORS[i].sensor_ctl = new gpio(CONFIG.DOORS[i].sensor_pin, 'in', 'both', {
            debounceTimeout: 500
        });
    }

    // Ensure that relay state is OFF on server start, for all doors.
    for (var i = 0; i < CONFIG.DOORS.length; i++) {
        CONFIG.DOORS[i].lift_ctl.write(1);
    }
}

// Creates a copy of the door configuration and strips the GPIO control methods from it, as we do not want to include them in the JSON response.
function strip_gpioCtl(doors) {
    var strippedList = [];
    for (var i = 0; i < doors.length; i++) {
        var newDoor = JSON.parse(JSON.stringify(doors[i]));
        delete newDoor.lift_ctl;
        delete newDoor.sensor_ctl;
        strippedList[i] = newDoor;
    }
    return strippedList;
}

function checkAuthorization(method, api_key, request) {
    var authorizedKeys = [];

    // strips ipv6 prefix from remoteAddress 
    var rawIP = request.connection.remoteAddress;
    var clientIP = rawIP.slice(rawIP.lastIndexOf(':') + 1, rawIP.length);

    // Populate authorized key list
    for (var i = 0; i < CONFIG.AUTHORIZED_KEYS.length; i++)
        authorizedKeys[i] = CONFIG.AUTHORIZED_KEYS[i].key;

    // If no API keys are available, do not enforce rules
    if (authorizedKeys.length < 1)
        return true;

    // If invalid API key supplied
    if (authorizedKeys.indexOf(api_key) == -1)
        return false;

    var keyPos = authorizedKeys.indexOf(api_key);

    // If IP address of request source appears on host blacklist
    if (CONFIG.AUTHORIZED_KEYS[keyPos].denyHosts.indexOf(clientIP) >= 0)
        return false;

    // If IP address of request source does not match host whitelist and permissions not set to allow ALL hosts
    if (CONFIG.AUTHORIZED_KEYS[keyPos].allowHosts.indexOf(clientIP) == -1 && CONFIG.AUTHORIZED_KEYS[keyPos].allowHosts.indexOf('ALL') == -1)
        return false;

    // If method called appears on blacklist for API key
    if (CONFIG.AUTHORIZED_KEYS[keyPos].denyMethods.indexOf(method) >= 0)
        return false;

    // If requested API method does not match permitted list and permissions not set to allow ALL methods
    if (CONFIG.AUTHORIZED_KEYS[keyPos].allowMethods.indexOf(method) == -1 && CONFIG.AUTHORIZED_KEYS[keyPos].allowMethods.indexOf('ALL') == -1)
        return false;

    return true;
}

// Trips circuit based on optional initial condition of door.
// Params:
//	id - id of door to open
// 	initialState - door state that must be satisfied in order to send command (e.g. switch position: 1 -> closed, 0 -> open)
// 	bypass - bypass state check (optional)
function tripCircuit(id, initialState, bypass) {

    // Never trip circuit on lockout 
    if (CONFIG.DOORS[id].lockout === true)
        return;

    if (bypass === true || CONFIG.DOORS[id].sensor_ctl.read() == initialState) {

        CONFIG.DOORS[id].lift_ctl.write(1); // Ensure that power is OFF initially.

        CONFIG.DOORS[id].lift_ctl.write(0); // power ON 

        setTimeout(function() {
            CONFIG.DOORS[id].lift_ctl.write(1);
        }, CONFIG.RELAY_TRIP_TIME); // power OFF again after CONFIG.RELAY_TRIP_TIME
    }
}
