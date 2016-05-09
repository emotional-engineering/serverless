'use strict';

/**
 * Action: DashDeploy Deploy
 * - Deploys Function Code & Endpoints
 * - Validates Function paths
 * - Loops sequentially through each Region in specified Stage
 * - Passes Function paths to Sub-Actions for deployment
 * - Handles concurrent processing of Sub-Actions for faster deploys
 *
 * Event Properties:
 * - stage:             (String)  The stage to deploy to
 * - regions:           (Array)   The region(s) in the stage to deploy to
 * - aliasFunction:     (String)  Custom Lambda alias.
 * - functions:         (Array)   Array of function JSONs from fun.sl.json
 * - description:         (String)  Provide custom description string for API Gateway stage deployment description.
 */

module.exports = function(S) {

  const path  = require('path'),
    SUtils    = S.utils,
    SError    = require(S.getServerlessPath('Error')),
    SCli      = require(S.getServerlessPath('utils/cli')),
    BbPromise = require('bluebird'),
    async     = require('async'),
    _         = require('lodash'),
    fs        = BbPromise.promisifyAll(require('fs'));

  class DashDeploy extends S.classes.Plugin {

    /**
     * Get Name
     */

    static getName() {
      return 'serverless.core.' + this.name;
    }

    /**
     * Register Plugin Actions
     */

    registerActions() {

      S.addAction(this.dashDeploy.bind(this), {
        handler:       'dashDeploy',
        description:   'Serverless Dashboard - Deploys both code & endpoint',
        context:       'dash',
        contextAction: 'deploy',
        options:       [
          {
            option:      'stage',
            shortcut:    's',
            description: 'Optional if only one stage is defined in project'
          }, {
            option:      'region',
            shortcut:    'r',
            description: 'Optional - Target one region to deploy to'
          }, {
            option:      'aliasFunction', // TODO: Implement
            shortcut:    'f',
            description: 'Optional - Provide a custom Alias to your Functions'
          }, {
            option:      'aliasEndpoint', // TODO: Implement
            shortcut:    'e',
            description: 'Optional - Provide a custom Alias to your Endpoints'
          }, {
            option:      'aliasRestApi',  // TODO: Implement
            shortcut:    'a',
            description: 'Optional - Provide a custom Api Gateway Stage Variable for your REST API'
          }, {
            option:      'description',
            shortcut:    'd',
            description: 'Optional - Provide custom description string for API Gateway stage deployment description'
          }
        ]
      });

      return BbPromise.resolve();
    }

    /**
     * Function Deploy
     */

    dashDeploy(evt) {

      let _this      = this;
      _this.evt      = evt;
      _this.evt.data = {};

      // Add defaults
      _this.evt.options.stage               = _this.evt.options.stage ? _this.evt.options.stage : null;
      _this.evt.options.aliasFunction       = _this.evt.options.aliasFunction ? _this.evt.options.aliasFunction : null;
      _this.evt.options.aliasEndpoint       = _this.evt.options.aliasEndpoint ? _this.evt.options.aliasEndpoint : null;
      _this.evt.options.aliasRestApi        = _this.evt.options.aliasRestApi ? _this.evt.options.aliasRestApi : null;
      _this.evt.options.selectedFunctions   = [];
      _this.evt.options.selectedEndpoints   = [];
      _this.evt.options.selectedEvents      = [];
      _this.evt.options.selectedRemovalEndpoints = [];
      _this.evt.data.deployedResources      = [];
      _this.evt.data.notExistEndpoints      = [];
      _this.evt.data.deployedFunctions      = {};
      _this.evt.data.deployedEndpoints      = {};
      _this.evt.data.removedEndpoints       = {};
      _this.evt.data.deployedEvents         = {};

      // Instantiate Classes
      _this.project    = S.getProject();

      // Flow
      return BbPromise.try(function() {
        })
        .bind(_this)
        .then(_this._validateAndPrepare)
        .then(function() {
          return _this.cliPromptSelectStage('Choose a Stage: ', _this.evt.options.stage, false)
            .then(stage => {
              _this.evt.options.stage = stage;
            })
        })
        .then(function() {
          return _this.cliPromptSelectRegion('Choose a Region in this Stage: ', false, true, _this.evt.options.region, _this.evt.options.stage)
            .then(region => {
              _this.evt.options.region = region;
            })
        })
        .then(_this._getDeployedResources)
        .then(deployedResources => {   
          _this.evt.data.deployedResources = deployedResources;
          return BbPromise.resolve();
        })        
        .then(_this._initNotExistEndpoints)        
        .then(_this._prompt)        
        .then(_this._deploy)
        .then(function() {
          return _this.evt;
        });
    }

    /**
     * Validate And Prepare
     * - If CLI, maps CLI input to event object
     */

    _validateAndPrepare() {

      let _this = this;

      // If not interactive, throw error
      if (!S.config.interactive) {
        return BbPromise.reject(new SError('Sorry, this is only available in interactive mode'));
      }

      return BbPromise.resolve();
    }
    
    /**
     * Get deployed api resources
     */
     
    _getDeployedResources() {

      let _this = this;

      let restApiId;

      let restApiName = S.getProject().getRegion(_this.evt.options.stage, _this.evt.options.region).getVariables()['apiGatewayApi'] || S.getProject().getName();

      S.initProviders();

      let aws = S.getProvider('aws');

      return aws.getApiByName(restApiName, _this.evt.options.stage, _this.evt.options.region)
        .then((restApiData) => restApiId = restApiData.id)
        .then(() => aws.request('APIGateway', 'getResources', {restApiId, limit: 500}, _this.evt.options.stage, _this.evt.options.region))
        .then(function(resources){
          return BbPromise.resolve(resources);
      });
    }

    /**
     * Fill the array of endpoints, that are deployed, but doesn't exist locally
     */

    _initNotExistEndpoints() {

      let _this = this;

      let localFunctions = SUtils.getFunctionsByCwd(_this.project.getAllFunctions());

      localFunctions.forEach(function(func){

        let localEndpoints = func.getAllEndpoints();

        let deployedResource = false;

        let funcNotExistEndpoints = [];

        // Search deployed resource for each function

        _this.evt.data.deployedResources.items.every(function(item){

          if (item.pathPart == func.getName())
          {
            deployedResource = item;
            return false; // break "every()"                                                                                
          }

          return true;

        });

        // Check each of the deployed method exists locally

        for (let method in deployedResource.resourceMethods)
        {

          let exist = false;

          for (let i = 0; i < localEndpoints.length; i++)
          {
            if (method == localEndpoints[i].method) {
              exist = true;
            }
          }

          if (!exist) {
            funcNotExistEndpoints.push(deployedResource.pathPart + "~" + method);
          }
        }

        _this.evt.data.notExistEndpoints.push(funcNotExistEndpoints);       

      })

      return true;

    }

    /**
     * Prompt
     */

    _prompt() {

      let _this = this,
          functions = SUtils.getFunctionsByCwd(_this.project.getAllFunctions());

      // Prepare function & endpoints choices
      let choices    = [];

      _.each( functions, function(func, i){
        // Push function function as spacer
        choices.push({
          spacer: func.getName()
        });

        choices.push({
          key:        '  ',
          value:      func.getName(),
          label:      `function - ${func.getName()}`,
          type:       'function'
        });

        _.each( func.getAllEndpoints(), function(endpoint){
          choices.push({
            key:        '  ',
            value:      `${endpoint.path}~${endpoint.method}`,
            label:      `endpoint - ${endpoint.path} - ${endpoint.method}`,
            type:       'endpoint'
          });
        });
                                
        _.each( _this.evt.data.notExistEndpoints[i], function(endpoint){
            
          let label = endpoint.split("~");
                               
          choices.push({
            key:        '  ',
            value:      endpoint,
            label:      "x endpoint removal - " + label[0] + " - " + label[1],
            type:       'endpoint',
            removal : true
          });  

        });        

        _.each( func.getAllEvents(), function(event){
          choices.push({
            key:        '  ',
            value:      event.name,
            label:      `event - ${event.name} - ${event.type}`,
            type:       'event'
          });
        });
      });

      // Show ASCII
      SCli.asciiGreeting();

      // Blank space for neatness in the CLI
      console.log('');

      // Show quick help
      SCli.quickHelp();

      // Blank space for neatness in the CLI
      console.log('');

      // Show select input
      return _this.cliPromptSelect('Select the assets you wish to deploy:', choices, true, 'Deploy')
        .then(function(items) {
          for (let i = 0; i < items.length; i++) {

            if (items[i].toggled)
            {

              if (items[i].removal && items[i].type === "endpoint")
              {
                _this.evt.options.selectedRemovalEndpoints.push(items[i].value);
                continue;
              }

              if(items[i].type === "function") _this.evt.options.selectedFunctions.push(items[i].value);
              if(items[i].type === "endpoint") _this.evt.options.selectedEndpoints.push(items[i].value);
              if(items[i].type === "event")    _this.evt.options.selectedEvents.push(items[i].value);
            }
          }

          // Blank space for neatness in the CLI
          console.log('');
        })
    }

    /**
     * Deploy
     */

    _deploy() {

      let _this = this;

      return new BbPromise(function(resolve, reject) {

        // If user selected functions, deploy them
        if (!_this.evt.options.selectedFunctions || !_this.evt.options.selectedFunctions.length) return resolve();

        return S.actions.functionDeploy({
            options: {
              stage:  _this.evt.options.stage,
              region: _this.evt.options.region,
              names:   _this.evt.options.selectedFunctions
            }
          })
          .then(function(evt) {
            _this.evt.data.deployedFunctions = evt.data.deployed;
            return resolve();
          });
        })
        .then(function() {

          // If user selected endpoints, deploy them
          if (!_this.evt.options.selectedEndpoints || !_this.evt.options.selectedEndpoints.length) return BbPromise.resolve();

          return S.actions.endpointDeploy({
              options: {
                stage:       _this.evt.options.stage,
                region:      _this.evt.options.region,
                names:       _this.evt.options.selectedEndpoints
              }
            })
            .then(function(evt) {
              _this.evt.data.deployedEndpoints = evt.data.deployed;
            });
        })
        .then(function() {

          // If user selected endpoints, deploy them
          if (!_this.evt.options.selectedEvents || !_this.evt.options.selectedEvents.length) return BbPromise.resolve();

          return S.actions.eventDeploy({
              options: {
                stage:       _this.evt.options.stage,
                region:      _this.evt.options.region,
                names:      _this.evt.options.selectedEvents
              }
            })
            .then(function(evt) {
              _this.evt.data.deployedEvents = evt.data.deployed;
            });
        })
        .then(function() {

          // If user selected removal of endpoints, remove them
          if (!_this.evt.options.selectedRemovalEndpoints || !_this.evt.options.selectedRemovalEndpoints.length) return BbPromise.resolve();

          return S.actions.endpointRemove({
              options: {
                stage:     _this.evt.options.stage,
                region:    _this.evt.options.region,             
                names:     _this.evt.options.selectedRemovalEndpoints,
                skipLocal: true
              }
            })
            .then(function(evt) {                                
                _this.evt.data.removedEndpoints = evt.data.removed;
            });
        })
    }
  }

  return( DashDeploy );
};
