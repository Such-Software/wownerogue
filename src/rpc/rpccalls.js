var axios = require('axios');
var request = require('request');

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
var daemonURL = 'http://localhost:34568/json_rpc';

function daemonCall(method, params, callback, io) {
    // Real blockchain call (now used for all cases)
    var body = constructCall(method, params);
    request({
        url: daemonURL,
        method: 'POST',
        headers: {"content-type": "application/json"},
        json: body
    }, function (error, res, body) {
        if (error) {
            console.log("Daemon connection error:", error.message);
            callback(null);
            return;
        }
        callback(body);
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
