'use strict';

const httpStatus = require('http-status-codes');
const _ = require('underscore');

const yieldable = require('abacus-yieldable');

const carryOverDb = require('../../utils/carry-over-db');
const serviceMock = require('../../utils/service-mock-util');
const createWait = require('abacus-wait');

const waitUntil = yieldable(createWait().until);

let fixture;

const build = () => {
  context('when abacus collector is down', () => {
    let externalSystemsMocks;
    let usageEventMetadata;

    before(yieldable.functioncb(function*() {
      externalSystemsMocks = fixture.externalSystemsMocks();
      externalSystemsMocks.startAll();

      externalSystemsMocks.uaaServer.tokenService
        .whenScopesAre(fixture.oauth.abacusCollectorScopes)
        .return(fixture.oauth.abacusCollectorToken);

      externalSystemsMocks.uaaServer.tokenService
        .whenScopesAre(fixture.oauth.cfAdminScopes)
        .return(fixture.oauth.cfAdminToken);

      const serviceUsageEvent = fixture.usageEvent().get();
      usageEventMetadata = serviceUsageEvent.metadata;

      externalSystemsMocks.cloudController.usageEvents.return.firstTime([serviceUsageEvent]);
      externalSystemsMocks.cloudController.usageEvents.return.secondTime([serviceUsageEvent]);

      // Event reporter (abacus-client) will retry 'fixture.env.retryCount'
      // times to report usage to abacus. After that the whole process is
      // retried (i.e. start reading again the events). Stub Abacus Collector
      // so that it will force the bridge to retry the whole proces.
      const failRequetsCount = fixture.env.retryCount + 1;
      const responses = _(failRequetsCount).times(() => httpStatus.BAD_GATEWAY);
      responses.push(httpStatus.ACCEPTED);

      externalSystemsMocks.abacusCollector.collectUsageService.return.series(responses);

      yield carryOverDb.setup();
      fixture.bridge.start(externalSystemsMocks);

      yield waitUntil(serviceMock(externalSystemsMocks.cloudController.usageEvents).received(3));
    }));

    after((done) => {
      fixture.bridge.stop();
      carryOverDb.teardown();
      externalSystemsMocks.stopAll(done);
    });

    it('Service Usage Events receive correct requests ', () => {
      const verifyServiceUsageEventsAfterGuid = (requestNumber, afterGuid) => {
        expect(externalSystemsMocks.cloudController.usageEvents.request(requestNumber).afterGuid).to.equal(afterGuid);
      };

      verifyServiceUsageEventsAfterGuid(0, undefined);
      verifyServiceUsageEventsAfterGuid(1, undefined);
      verifyServiceUsageEventsAfterGuid(2, usageEventMetadata.guid);
    });

    it('Abacus Collector receives the same requests', () => {
      // retryCount+1 failing requests, and one successful.
      const expectedRequestsCount = fixture.env.retryCount + 2;
      const expectedRequests = _(expectedRequestsCount).times(() => ({
        token: fixture.oauth.abacusCollectorToken,
        usage: fixture.collectorUsage()
          .overwriteUsageTime(usageEventMetadata.created_at)
          .overwriteMeasuredUsage(fixture.usageEventStates.default)
          .get()
      }));

      expect(externalSystemsMocks.abacusCollector.collectUsageService.requests()).to.deep.equal(expectedRequests);
    });

    it('Exposes correct statistics', yieldable.functioncb(function*() {
      const response = yield fixture.bridge.readStats.withValidToken();
      expect(response.statusCode).to.equal(httpStatus.OK);
      expect(response.body.statistics.usage).to.deep.equal({
        success: {
          all: 1,
          conflicts: 0,
          notsupported: 0,
          skips: 0
        },
        failures: 1
      });
    }));
  });
};

const testDef = {
  fixture: (value) => {
    fixture = value;
    return testDef;
  },
  build
};

module.exports = testDef;
