'use strict';

// Test a module using Istanbul and Mocha

// Implemented in ES5 for now
/* eslint no-var: 0 */

if(process.env.LONGJOHN)
  require('longjohn');
var _ = require('underscore');
var path = require('path');
var util = require('util');
var smap = require('source-map');
var csmap = require('convert-source-map');
var textcov = require('./textcov.js');
var istanbul = require('istanbul');
var Mocha = require('mocha');
var fs = require('fs');
var tty = require('tty');
var commander = require('commander');

var map = _.map;
var values = _.values;
var contains = _.contains;
var memoize = _.memoize;

/* eslint no-process-exit: 1 */
/* eslint no-eval: 1 */
/* jshint evil: true */

// Return true if a file belongs to the current module
var inThisModule = function(file) {
  var rel = path.relative(process.cwd(), file);
  return /^(src|lib)\/([^\/]*\/)?[^\/]*\.js$/.test(rel);
};

// Return true if a file is in a test directory
var inTestDir = function(file) {
  var rel = path.relative(process.cwd(), file);
  return /^(src|lib)\/test\//.test(rel);
};

// Return a file matcher function that will return true if a file should be
// instrumented with Istanbul. The matcher will match files in the current
// module or any module name matching the given include pattern, excluding
// files in test directories.
var instrumentMatcher = function(include) {
  var ix = new RegExp('\/' + include + '[^\/]*\/lib\/([^\/]*\/)?[^\/]*\.js$');
  var inIncludedModule = function(file) {
    return ix.test(file);
  };
  return function(file) {
    return (inThisModule(file) || inIncludedModule(file)) && !inTestDir(file);
  };
};

// Return the path to the original source of a file. If the file is under a
// lib directory assume that it's an ES5 file generated by Babel from an
// ES6 source file in a peer src directory.
var src = function(file) {
  var lib = file.split('/');
  var l = lib.lastIndexOf('lib');
  if(l === -1)
    return file;
  return lib.slice(0, l).concat(['src']).concat(lib.slice(l + 1)).join('/');
};

// Return a transform function that transforms a file and records the original
// source and a source map in the given sets
var transformer = function(sources, maps) {
  // Set up an instrument function that will instrument the relevant code
  var instrumenter = new istanbul.Instrumenter({
    coverageVariable: '__coverage',
    preserveComments: true
  });

  // Return the configured transform function
  return function(code, file) {
    // Skip files that contain /istanbul ignore file/
    if(/istanbul ignore file/.test(code))
      return code;

    // Save the original source of each instrumented file
    sources[file] = fs.readFileSync(src(file)).toString();

    // Record the corresponding source map
    var sm = csmap.fromSource(code);
    if(sm)
      maps[file] = new smap.SourceMapConsumer(sm.sourcemap);

    // Instrument with Istanbul
    process.stdout.write(
      util.format('Running Istanbul instrumentation on %s\n',
      path.relative(process.cwd(), file)));
    return instrumenter.instrumentSync(code, file);
  };
};

// Remap Istanbul statement, function and branch coverage maps to the original
// source code using the given set of source maps
var remap = function(coverage, maps) {
  map(values(coverage), function(cov) {
    var m = maps[cov.path];
    if(!m) return;

    var reloc = function(l) {
      var start = m.originalPositionFor(l.start);
      if(start.line !== null)
        l.start = start;
      var end = m.originalPositionFor(l.end);
      if(end.line !== null)
        l.end = end;
    };

    map(values(cov.statementMap), function(s) {
      reloc(s);
    });
    map(values(cov.fnMap), function(f) {
      reloc(f.loc);
      f.line = f.loc.start.line;
    });
    map(values(cov.branchMap), function(b) {
      map(b.locations, function(l) {
        reloc(l);
      });
      b.line = b.locations[0].start.line;
    });
  });
  return coverage;
};

// Return the directory containing the test target sources
var target = function() {
  try {
    fs.lstatSync('lib');
    return 'lib';
  }
  catch (e) {
    return 'src';
  }
};

// Colorify the report on a tty or when requested on the command line
var colorify = memoize(function(opt) {
  return tty.isatty(process.stdout) || opt.color;
});

// Run Mocha with Istanbul
var runCLI = function() {
  process.stdout.write('Testing...\n');

  // Parse command line options
  if(contains(process.argv, '--command')) {
    commander.istanbul = false;
    commander.color = true;
  }
  else {
    commander
      .option('--no-istanbul', 'do not instrument with Istanbul')
      .option('-i, --istanbul-includes <regex>',
        'instrument matching modules with Istanbul [abacus]', 'abacus')
      .option('--no-color', 'do not colorify output')
      .parse(process.argv);
    if(process.env.NO_ISTANBUL)
      commander.istanbul = false;
  }

  // Time the execution of the tests
  var t0 = new Date();

  // Configure Mocha
  var mocha = new Mocha({
    timeout: 60000,
    useColors: colorify(commander)
  });

  // Install Chai expect and Sinon spy and stub as globals
  global.chai = require('chai');
  global.expect = global.chai.expect;
  global.sinon = require('sinon');
  global.spy = global.sinon.spy;
  global.stub = global.sinon.stub;

  // Install an Istanbul require hook that will instrument files that
  // match our instrumentMatcher
  var sources = [];
  var maps = [];
  if(commander.istanbul)
    istanbul.hook.hookRequire(
      instrumentMatcher(commander.istanbulIncludes),
      transformer(sources, maps));

  // Run the test with Mocha
  var testDir = path.join(target(), 'test');
  fs.readdirSync(testDir).filter(function(file) {
    return file.substr(-7) === 'test.js';
  }).forEach(function(file) {
    mocha.addFile(path.join(testDir, file));
  });
  mocha.run(function(failures) {
    var t1 = Date.now();

    // Print the test execution time
    var time = function() {
      process.stdout.write(util.format('\nRun time %dms\n', t1 - t0));
    };

    if(!global.__coverage) {
      time();
      process.exit(failures);
    }

    // Remap the generated source coverage maps using the collected source
    // maps
    remap(global.__coverage, maps);

    // Write the JSON and LCOV coverage reports
    var collector = new istanbul.Collector();
    collector.add(global.__coverage);
    var coverage = collector.getFinalCoverage();
    var reporter = new istanbul.Reporter(undefined, '.coverage');
    reporter.addAll(['lcovonly']);
    reporter.write(collector, false, function() {
      fs.writeFileSync('.coverage/coverage.json', JSON.stringify(coverage));

      // Print a detailed source coverage text report and the test
      // execution time
      textcov(coverage, sources, {
        color: colorify(commander)
      });
      time();

      process.exit(failures);
    });
  });
};

// Export our public functions
module.exports.runCLI = runCLI;

