/**
 * UI utilities and helpers for the Wowngeon game
 */
const UI = {
    // Scroll chat to bottom
    scrollChat: function() {
        var messageBox = $('#messageBox');
        messageBox.scrollTop(messageBox.prop("scrollHeight"));
    },

    // Update block height display
    updateBlockHeight: function(height) {
        $('#heightValue').text(height);
    },

    // Update visual focus indicator
    updateFocusIndicator: function() {
        var gameDisplay = $('#game-display');
        var chatInput = $('#chatInput');

        if (document.activeElement === gameDisplay[0]) {
            gameDisplay.css('outline', '2px solid yellow');
            chatInput.css('outline', 'none');
        } else if (document.activeElement === chatInput[0]) {
            chatInput.css('outline', '2px solid cyan');
            gameDisplay.css('outline', 'none');
        } else {
            gameDisplay.css('outline', 'none');
            chatInput.css('outline', 'none');
        }
    },

    // Initialize teletype animation
    initTeletype: function() {
        $('#banner').teletype({
            text: ["Welcome traveler...", "You have arrived at...", "The Dungeon"],
            typeDelay: 100,
            backDelay: 50,
            pause: 1500
        });
        
        // After animations are complete, set static text
        setTimeout(function() {
            $('#banner, #bannercursor').fadeOut(500, function() {
                const title = UI._gameTitleFull || "WOWNEROGUE - A Wownero Roguelike";
                $('#staticbanner').text(title).fadeIn(500);
            });
        }, 14000);
    },

    _gameTitleFull: "WOWNEROGUE - A Wownero Roguelike",

    updateGameTitle: function(cryptoType) {
        if (cryptoType === 'XMR') {
            document.title = "XMROGUE - A Monero Roguelike";
            this._gameTitleFull = "XMROGUE - A Monero Roguelike";
        } else {
            document.title = "Wownerogue - A Wownero Roguelike";
            this._gameTitleFull = "WOWNEROGUE - A Wownero Roguelike";
        }

        // If the static banner is already visible (animation finished), update it immediately
        if ($('#staticbanner').is(':visible') && !$('#banner').is(':visible')) {
            $('#staticbanner').text(this._gameTitleFull);
        }
    },

    // Initialize browser detection
    initBrowserDetection: function() {
        setTimeout(function() {
            var browserInfo = document.getElementById('browser-info');
            if (!browserInfo) return;
            
            browserInfo.style.display = 'block';
            
            // Detect browser
            var browserName = "Unknown";
            if (navigator.userAgent.indexOf("Firefox") !== -1) {
                browserName = "Firefox";
            } else if (navigator.userAgent.indexOf("Chrome") !== -1) {
                browserName = "Chrome/Chromium";
            } else if (navigator.userAgent.indexOf("Safari") !== -1) {
                browserName = "Safari";
            } else if (navigator.userAgent.indexOf("Edge") !== -1) {
                browserName = "Edge";
            }
            
            document.getElementById('browser-name').textContent = browserName;
            
            // Check display status
            var rotdis = document.querySelector('.rotdis');
            var canvas = rotdis ? rotdis.querySelector('canvas') : null;
            
            if (canvas) {
                document.getElementById('display-status').textContent = 
                    "OK (" + canvas.width + "x" + canvas.height + ")";
                document.getElementById('display-status').style.color = "#0f0";
            } else {
                document.getElementById('display-status').textContent = "NOT FOUND";
                document.getElementById('display-status').style.color = "#f00";
            }
            
            // Hide after 10 seconds
            setTimeout(function() {
                browserInfo.style.display = 'none';
            }, 10000);
        }, 2000);
    },

    // Set test values if no server response
    setTestValues: function() {
        setTimeout(function() {
            if ($('#heightValue').text() === 'Loading...') {
                UI.updateBlockHeight('---');
                $('#statusValue').text('Waiting...');
                $('#statusValue').css('color', '#ff0');
            }
        }, 5000);
    }
};

// Ensure UI is available globally
if (typeof window !== 'undefined') {
    window.UI = UI;
}

// Initialize UI components when DOM is ready
$(function() {
    UI.initTeletype();
    UI.initBrowserDetection();
    UI.setTestValues();
});
