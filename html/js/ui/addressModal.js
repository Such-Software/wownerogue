(function(window, $) {
    const AddressModal = {
        _initialized: false,
        _isVisible: false,
        _pending: false,
        _currentAddress: null,
        _elements: {},

        init() {
            if (this._initialized) {
                return;
            }

            this._elements.overlay = $('#addressModal');
            this._elements.input = $('#addressModalInput');
            this._elements.form = $('#addressModalForm');
            this._elements.close = $('#addressModalClose');
            this._elements.cancel = $('#addressModalCancel');
            this._elements.feedback = $('#addressModalFeedback');
            this._elements.saveButton = $('#addressModalSave');

            if (!this._elements.overlay.length) {
                console.warn('AddressModal: modal markup not found.');
                return;
            }

            this._elements.close.on('click', (evt) => {
                evt.preventDefault();
                this.hide();
            });
            this._elements.cancel.on('click', (evt) => {
                evt.preventDefault();
                this.hide();
            });
            this._elements.overlay.on('click', (evt) => {
                if (evt.target === this._elements.overlay[0]) {
                    this.hide();
                }
            });

            this._elements.form.on('submit', (evt) => {
                evt.preventDefault();
                this.handleSubmit();
            });

            this._initialized = true;
        },

        ensureInit() {
            if (!this._initialized) {
                this.init();
            }
        },

        show({ existingAddress = null, message = null } = {}) {
            this.ensureInit();
            if (!this._elements.overlay.length) {
                return;
            }

            if (typeof existingAddress === 'string' && existingAddress.trim().length > 0) {
                this._currentAddress = existingAddress.trim();
            }

            const value = this._currentAddress || existingAddress || '';
            this._elements.input.val(value);
            this._elements.input.trigger('focus');

            if (message) {
                this.setFeedback(message, 'info');
            } else {
                this.clearFeedback();
            }

            this.setPending(false);
            this._elements.overlay.removeClass('hidden');
            this._isVisible = true;
        },

        hide() {
            if (!this._isVisible) {
                return;
            }
            this._elements.overlay.addClass('hidden');
            this._isVisible = false;
            this.setPending(false);
            this.clearFeedback();
        },

        setFeedback(text, type = 'info') {
            if (!this._elements.feedback.length) return;
            this._elements.feedback.text(text || '');
            this._elements.feedback.removeClass('error success info');
            this._elements.feedback.addClass(type);
        },

        clearFeedback() {
            if (!this._elements.feedback.length) return;
            this._elements.feedback.text('');
            this._elements.feedback.removeClass('error success info');
        },

        setCurrentAddress(address) {
            if (typeof address === 'string' && address.trim()) {
                this._currentAddress = address.trim();
                if (this._isVisible && !this._pending) {
                    this._elements.input.val(this._currentAddress);
                }
            }
        },

        setPending(state) {
            this._pending = Boolean(state);
            if (!this._elements.saveButton?.length) {
                return;
            }
            if (!this._pending && this._isVisible) {
                this._elements.saveButton.prop('disabled', false).text('Save Address');
            } else if (this._pending) {
                this._elements.saveButton.prop('disabled', true).text('Saving…');
            } else {
                this._elements.saveButton.prop('disabled', false);
            }
        },

        handleError(message) {
            this.setPending(false);
            if (message) {
                this.setFeedback(message, 'error');
            }
        },

        onConfirmed({ address, message }) {
            if (address) {
                this.setCurrentAddress(address);
            }
            if (this._isVisible) {
                if (message) {
                    this.setFeedback(message, 'success');
                }
                this.setPending(false);
                this.hide();
            }
        },

        handleSubmit() {
            if (this._pending) {
                return;
            }
            const value = (this._elements.input.val() || '').trim();
            if (!value) {
                this.setFeedback('Please enter a payout address.', 'error');
                this._elements.input.focus();
                return;
            }

            if (value.length < 80 || value.length > 128) {
                this.setFeedback('That address length looks off. Please double-check and try again.', 'error');
                return;
            }

            if (!window.socket) {
                this.setFeedback('Socket connection not ready. Try again shortly.', 'error');
                return;
            }

            this.setPending(true);
            this.setFeedback('Saving address…', 'info');
            window.socket.emit('address:update', { address: value });
        }
    };

    $(function() {
        AddressModal.init();
    });

    window.AddressModal = AddressModal;
})(window, jQuery);
