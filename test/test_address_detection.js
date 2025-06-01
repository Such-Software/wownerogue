/**
 * Test script for XMR/WOW address detection system
 */

// Test the regex patterns used in socketHandlers.js
function testAddressDetection() {
    console.log('🧪 Testing XMR/WOW Address Detection System\n');

    // XMR mainnet addresses start with 4, 8, A, or B and are 95 characters  
    // WOW addresses start with W and are 97 characters
    const xmrRegex = /\b[48AB][1-9A-HJ-NP-Za-km-z]{94}\b/;
    const wowRegex = /\bW[1-9A-HJ-NP-Za-km-z]{96}\b/;

    function detectXMRAddress(message) {
        const xmrMatch = message.match(xmrRegex);
        const wowMatch = message.match(wowRegex);
        
        if (xmrMatch) {
            return { address: xmrMatch[0], type: 'XMR' };
        }
        if (wowMatch) {
            return { address: wowMatch[0], type: 'WOW' };
        }
        
        return null;
    }

    // Test cases with real address formats
    const testCases = [
        {
            name: 'Valid XMR Address (starts with 8)',
            message: 'Here is my XMR address: 8Bqez9dvqY9bw3CgwMC9X1c8MX5KuRgKbiXRWg2F9UtYNYLevqjJXbQW4qYHUM1JF1792hhWYJLUufSUn9GvSC4G6wjMiRL',
            expected: { address: '8Bqez9dvqY9bw3CgwMC9X1c8MX5KuRgKbiXRWg2F9UtYNYLevqjJXbQW4qYHUM1JF1792hhWYJLUufSUn9GvSC4G6wjMiRL', type: 'XMR' }
        },
        {
            name: 'Valid XMR Address (starts with 4)',
            message: 'Send to: 44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A',
            expected: { address: '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A', type: 'XMR' }
        },
        {
            name: 'Valid WOW Address (starts with WW)',
            message: 'My WOW address is: WW35SBkcZDNGRkLroGNg4tKuJtyV8JhA95CREopLPCwrj9LgRU5pSnDb4D5BHKo9oBAZSjHXWnDwCJ4mRL5F6iJ81vSmNBuRC',
            expected: { address: 'WW35SBkcZDNGRkLroGNg4tKuJtyV8JhA95CREopLPCwrj9LgRU5pSnDb4D5BHKo9oBAZSjHXWnDwCJ4mRL5F6iJ81vSmNBuRC', type: 'WOW' }
        },
        {
            name: 'Valid WOW Address (starts with Wo)',
            message: 'please send to Wo3MWeKwtA918DU4c69hVSNgejdWFCRCuWjShRY66mJkU2Hv58eygJWDJS1MNa2Ge5M1WjUkGHuLqHkweDxwZZU42d16v94mP thanks',
            expected: { address: 'Wo3MWeKwtA918DU4c69hVSNgejdWFCRCuWjShRY66mJkU2Hv58eygJWDJS1MNa2Ge5M1WjUkGHuLqHkweDxwZZU42d16v94mP', type: 'WOW' }
        },
        {
            name: 'Invalid XMR (too short)',
            message: '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRJ5zA4NJD9QhKCciJBcH9qPq8FgZKR8U8n',
            expected: null
        },
        {
            name: 'Invalid XMR (wrong prefix)',
            message: '3AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRJ5zA4NJD9QhKCciJBcH9qPq8FgZKR8U8nZZZZ',
            expected: null
        },
        {
            name: 'Invalid WOW (wrong prefix)',
            message: 'XW35SBkcZDNGRkLroGNg4tKuJtyV8JhA95CREopLPCwrj9LgRU5pSnDb4D5BHKo9oBAZSjHXWnDwCJ4mRL5F6iJ81vSmNBuRC',
            expected: null
        },
        {
            name: 'No address in message',
            message: 'hello world this is just a chat message',
            expected: null
        },
        {
            name: 'Partial address in message',
            message: 'my address starts with 4AdUnd but I wont share the full thing',
            expected: null
        }
    ];

    let passed = 0;
    let failed = 0;

    testCases.forEach((testCase, index) => {
        console.log(`Test ${index + 1}: ${testCase.name}`);
        console.log(`Message: "${testCase.message}"`);
        
        const result = detectXMRAddress(testCase.message);
        
        if (JSON.stringify(result) === JSON.stringify(testCase.expected)) {
            console.log(`✅ PASS - Detected: ${result ? `${result.type} ${result.address}` : 'null'}`);
            passed++;
        } else {
            console.log(`❌ FAIL - Expected: ${JSON.stringify(testCase.expected)}`);
            console.log(`❌ FAIL - Got: ${JSON.stringify(result)}`);
            failed++;
        }
        console.log('');
    });

    console.log(`📊 Test Results: ${passed} passed, ${failed} failed`);
    
    if (failed === 0) {
        console.log('🎉 All tests passed! Address detection system is working correctly.');
    } else {
        console.log('⚠️  Some tests failed. Please review the regex patterns.');
    }
}

// Run the tests
testAddressDetection();

module.exports = { testAddressDetection };
