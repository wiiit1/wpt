(function () {
    
  // Get values from the substitution engine.
  // We can't just pull these from the document context
  // because this script is intended to be transcluded into
  // another document, and we want the GET values used to request it,
  // not the values for the including document
    
  // XXX these are unencoded, so there's an unavoidable
  // injection vulnerability in constructing this file...
  // need to upgrade the template engine.
  var reportField  = "{{GET[reportField]}}";
  var reportValue  = "{{GET[reportValue]}}";
  var reportExists = "{{GET[reportExists]}}";
    
  console.log("reportField: " + reportField);
  console.log("reportValue: " + reportValue);
  console.log("reportExists: " + reportExists);
    
  var thisTestName = document.location.pathname.split('/')[document.location.pathname.split('/').length - 1].split('.')[0];

  console.log("thisTestName: \"" + thisTestName + "\"");    
  var reportID = "";

  var cookies = document.cookie.split(';');
  for (var i = 0; i < cookies.length; i++) {
      var cookieName = cookies[i].split('=')[0].trim();
      var cookieValue = cookies[i].split('=')[1].trim();
      
      console.log("found cookie name: \"" + cookieName + "\"");
      if (cookieName == thisTestName) {
          console.log("matching cookie, report GUID is " + cookieValue);
          reportID = cookieValue;
          var cookieToDelete = cookieName + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=" + document.location.pathname.substring(0,document.location.pathname.lastIndexOf('/')+1);
          console.log("removing: " + cookieToDelete);
          document.cookie = cookieToDelete;
          break;
      }
  }
    
  var reportLocation = document.location.protocol + "//" + document.location.host + "/content-security-policy/support/report.py?op=take&reportID=" + reportID;

    
  var reportTest = async_test("Violation report was sent.");    
    
  function reportOnLoad() {
      
    var data = "";
      
    if(this.responseText) {
        data = JSON.parse(this.responseText);
        console.log(JSON.stringify(data));
    }    
      
    reportTest.step(function () {
            if (reportExists == "false" && (data === null || data == "" || data.error)) {
                assert_true(true, "No report sent.");
                reportTest.done();
            } else if (reportExists == "true" && (data === null || data == "" || data.error)) {
                assert_true(false, "Report not sent.");
                reportTest.done();
            } else if (data === null || data == "") {
                assert_false(true, "Report not sent.");
                reportTest.done();
            } else {

                // Firefox expands 'self' or origins to the actual origin value
                // so "www.example.com" becomes "http://www.example.com:80"
                // accomodate this by just testing that the correct directive name
                // is reported, not the details... 

                assert_true(data["csp-report"][reportField].indexOf(reportValue.split(" ")[0]) != -1,
                    reportField + " value of  \"" + data["csp-report"][reportField] + "\" did not match " + reportValue.split(" ")[0] + ".");
                reportTest.done();
            }
        }, "");

  }
    
  var report = new XMLHttpRequest(); 
  report.onload = reportOnLoad;
  report.open("GET", reportLocation, true);
  report.send();


  })();