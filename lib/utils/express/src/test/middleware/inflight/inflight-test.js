'use strict';

const inflightMod = require('../../../lib/middleware/inflight/inflight');

const httpStatus = require('http-status-codes');
const EventEmitter = require('events').EventEmitter;


describe('inflight', () => {

  let response, sendRequest;
  const next = sinon.spy();

  const request = {
    client: {
      server: {
        inflight: {
          total: 0,
          client: 0
        },
        emit: sinon.spy()
      }
    },
    context: {
      oauth: {
        scopes: {
          readResourceScopes: ['test-read-client-scope'],
          writeResourceScopes: ['test-write-client-scope'],
          hasSystemReadScope: false,
          hasSystemWriteScope: false
        }
      }
    }
  };

  const setRequestScopes = (hasSystemScope) => {
    if(hasSystemScope) {
      request.context.oauth.scopes.readResourceScopes = ['test-read-system-scope'];
      request.context.oauth.scopes.writeResourceScopes = ['test-write-system-scope'];
    } else {
      request.context.oauth.scopes.readResourceScopes = ['test-read-client-scope'];
      request.context.oauth.scopes.writeResourceScopes = ['test-write-client-scope'];
    }

    request.context.oauth.scopes.hasSystemReadScope = hasSystemScope;
    request.context.oauth.scopes.hasSystemWriteScope = hasSystemScope;
  };


  const resetResponse = () => {
    response = new EventEmitter;
    response.status = sinon.stub();
    response.status.returns({
      send: sinon.stub()
    });
  };

  const resetRequestCounters = () =>
    request.client.server.inflight = {
      total: 0,
      client: 0
    };

  const verifyEmitEvent = (event, cb) => {
    response.emit(event);
    setTimeout(() => {
      expect(request.client.server.inflight.total).to.equal(0);
      cb();
    }, 500);
  };

  const setup = () => {
    resetResponse();
    resetRequestCounters();
    sendRequest = inflightMod(1, 1, true, true);
  };

  describe('when secured', () => {

    describe('when a request has a client scope', () => {

      before(() => {
        setRequestScopes(false);
      });

      context('is within inflight limits', () => {

        beforeEach(() => {
          setup();
          sendRequest(request, response, next);
        });

        it('should delegate call to downstream middlewares', () => {
          assert.called(next);
          expect(request.client.server.inflight.total).to.equal(1);
        });

        it('should decrease the counter when the request is finish', (done) => {
          verifyEmitEvent('finish', done);
        });

        it('should decrease the counter when the request is close', (done) => {
          verifyEmitEvent('close', done);
        });
      });

      context('is outside inflight limits', () => {
        beforeEach(() => {
          resetRequestCounters();
          sendRequest = inflightMod(1, 1, true, true);
        });


        it('should return SERVICE_UNAVAILABLE', () => {
          sendRequest(request, response, next);
          sendRequest(request, response, next);

          assert.calledWith(response.status, httpStatus.SERVICE_UNAVAILABLE);
          assert.calledWith(response.status().send, {
            message: 'The server is overloaded. Please try again later',
            status: httpStatus.SERVICE_UNAVAILABLE
          });
        });
      });
    });

    describe('when a request has a system scope', () => {

      before(() => {
        setRequestScopes(true);
      });

      context('is within inflight limits', () => {

        beforeEach(() => {
          setup();
          sendRequest(request, response, next);
        });

        it('should delegate call to downstream middlewares', () => {
          assert.called(next);
          expect(request.client.server.inflight.total).to.equal(1);
        });

        it('should decrease the counter when the request is finish', (done) => {
          verifyEmitEvent('finish', done);
        });

        it('should decrease the counter when the request is close', (done) => {
          verifyEmitEvent('close', done);
        });
      });

      context('is outside inflight limits', () => {
        beforeEach(() => {
          resetRequestCounters();
          sendRequest = inflightMod(1, 1, true);
        });


        it('should return SERVICE UNAVAILABLE', () => {
          sendRequest(request, response, next);
          sendRequest(request, response, next);

          assert.calledWith(response.status, httpStatus.SERVICE_UNAVAILABLE);
          assert.calledWith(response.status().send, {
            message: 'The server is overloaded. Please try again later',
            status: httpStatus.SERVICE_UNAVAILABLE
          });
        });
      });
    });

    describe('when receiving both client and system requests', () => {
      context('client inflight limit is full', () => {

        before(() => {
          next.resetHistory();
        });

        beforeEach(() => {
          setup();
        });

        it('system calls should pass while new client requests should be rejected', () => {
          setRequestScopes(false);
          sendRequest(request, response, next);
          assert.calledOnce(next);

          sendRequest(request, response, next);
          assert.calledOnce(next);

          setRequestScopes(true);
          sendRequest(request, response, next);
          assert.calledTwice(next);

          expect(request.client.server.inflight.total).to.equal(2);
          expect(request.client.server.inflight.client).to.equal(1);
          expect(request.client.server.inflight.remaining).to.equal(1);
        });
      });
    });

    describe('when handling requests', () => {
      context('client request is processed', () => {
        before(() => {
          request.client.server.emit.resetHistory();
          setRequestScopes(false);
          setup();
        });
        it('should emit "quite" from server when there are no more requests to handle', () => {
          sendRequest(request, response, next);
          verifyEmitEvent('finish');
          assert.calledWith(request.client.server.emit, 'quiet');
        });
      });
    });
  });

  describe('when not secured', () => {

    describe('when a request has a client scope and system inflight is enabled', () => {

      before(() => {
        request.context = undefined;
      });

      context('is inside inflight limits', () => {
        before(() => {
          resetResponse();
          resetRequestCounters();
          sendRequest = inflightMod(1, 0, false, true);

          sendRequest(request, response, next);
        });


        it('should succeed', () => {
          assert.called(next);
          expect(request.client.server.inflight.total).to.equal(1);
        });
      });
    });

    describe('when a request has a client scope and system inflight is disabled', () => {

      before(() => {
        request.context = undefined;
      });

      context('is inside inflight limits', () => {
        before(() => {
          resetResponse();
          resetRequestCounters();
          sendRequest = inflightMod(1, 0, false, false);

          sendRequest(request, response, next);
        });


        it('should succeed', () => {
          assert.called(next);
          expect(request.client.server.inflight.total).to.equal(1);
        });
      });
    });

  });
});
