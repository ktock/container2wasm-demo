var Module = {
    'locateFile': function(path, prefix) {
        return prefix + '/containers/' + path;
    }
};

var args = getArgs();
if (args) {
    Module['arguments'] = ['--entrypoint', '/bin/sh', '--', '-c', args]
}

function getArgs() {
    var vars = location.search.substring(1).split('&');
    for (var i = 0; i < vars.length; i++) {
        var kv = vars[i].split('=');
        if (decodeURIComponent(kv[0]) == 'args') {
            return decodeURIComponent(kv[1]);
        }
    }
}
