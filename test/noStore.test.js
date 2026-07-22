const noStore = require('../src/middleware/noStore');

describe('authenticated API cache policy', () => {
    test('sets explicit no-store headers before continuing', () => {
        const headers = {};
        const response = {
            setHeader: jest.fn((name, value) => { headers[name] = value; })
        };
        const next = jest.fn();

        noStore({}, response, next);

        expect(headers).toEqual({
            'Cache-Control': 'no-store, max-age=0',
            Pragma: 'no-cache',
            Expires: '0'
        });
        expect(next).toHaveBeenCalledTimes(1);
    });
});
