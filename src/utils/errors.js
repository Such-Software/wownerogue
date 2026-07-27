class AppError extends Error {
    constructor(message, {
        statusCode = 500,
        code = 'INTERNAL_ERROR',
        safeMessage = 'An unexpected error occurred.',
        isOperational = true,
        details = null,
        cause = undefined
    } = {}) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.code = code;
        this.safeMessage = safeMessage || 'An unexpected error occurred.';
        this.isOperational = isOperational;
        this.details = details;
        if (cause) {
            this.cause = cause;
        }
        Error.captureStackTrace?.(this, this.constructor);
    }
}

class ValidationError extends AppError {
    constructor(message, options = {}) {
        super(message, {
            statusCode: 400,
            code: 'VALIDATION_ERROR',
            safeMessage: message,
            ...options
        });
    }
}

class NotFoundError extends AppError {
    constructor(message, options = {}) {
        super(message, {
            statusCode: 404,
            code: 'NOT_FOUND',
            safeMessage: options.safeMessage || message,
            ...options
        });
    }
}

class ExternalServiceError extends AppError {
    constructor(message, options = {}) {
        super(message, {
            statusCode: options.statusCode || 502,
            code: options.code || 'EXTERNAL_SERVICE_ERROR',
            safeMessage: options.safeMessage || 'Upstream service error. Please try again later.',
            ...options
        });
    }
}

const isTrustedError = (error) => {
    return error instanceof AppError && error.isOperational !== false;
};

const normalizeError = (error, fallbackMessage = 'An unexpected error occurred.') => {
    if (!error) {
        return new AppError(fallbackMessage);
    }
    if (error instanceof AppError) {
        return error;
    }
    return new AppError(error.message || fallbackMessage, {
        safeMessage: fallbackMessage,
        cause: error,
        isOperational: false
    });
};

module.exports = {
    AppError,
    ValidationError,
    NotFoundError,
    ExternalServiceError,
    isTrustedError,
    normalizeError
};
