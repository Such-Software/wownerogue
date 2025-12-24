var axios = require('axios');

// Environment-based console logging control
const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';

/*List of RPC calls
Daemon -
Get blockheight: "get_block_count"
*/

function constructCall(method, params) {
    var body = {
        "jsonrpc": "2.0",
        "id": "0",
        "method": method,
        "params": params
    }
    return body;
}

var lastBlock = {
    height: 0,
    hash: 0,
    setHeight: function(newHeight) {this.height = newHeight}
}

// Use environment variable for daemon URL, fallback to localhost for backward compatibility
var daemonURL = process.env.PRIMARY_RPC_ENDPOINT ? 
    process.env.PRIMARY_RPC_ENDPOINT + '/json_rpc' : 
    'http://localhost:34568/json_rpc';

if (CONSOLE_LOGGING) {
    console.log(`🔗 Legacy RPC service using URL: ${daemonURL}`);
}

function daemonCall(method, params, callback, io) {
    // Real blockchain call using axios
    var body = constructCall(method, params);
    axios.post(daemonURL, body, {
        headers: { "content-type": "application/json" },
        timeout: 10000
    })
    .then(function(response) {
        callback(response.data);
    })
    .catch(function(error) {
        if (CONSOLE_LOGGING) {
            console.log("Daemon connection error:", error.message);
        }
        callback(null);
    });
}

function getBlockHeight(body) {
    if (body == null || body.result == null || body.result.count == null) {
        return null;
    }
    return body.result.count;
}


// Export the functions
module.exports = {
    daemonCall: daemonCall,
    getBlockHeight: getBlockHeight,
    lastBlock: lastBlock,
};
