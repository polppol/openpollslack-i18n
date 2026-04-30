function getTeamOrEnterpriseId(body) {
  body = JSON.parse(JSON.stringify(body));
  //logger.debug(body);
  if (body.hasOwnProperty('isEnterpriseInstall')) {
    if (body.isEnterpriseInstall === 'true' || body.isEnterpriseInstall === true) {
      if (body.hasOwnProperty('enterprise_id')) return body.enterprise_id;
      else if (body.hasOwnProperty('enterpriseId')) return body.enterpriseId;
      else if (body?.enterprise?.id !== undefined) return body.enterprise.id;
    } else {
      if (body.hasOwnProperty('team_id')) return body.team_id;
      else if (body.hasOwnProperty('teamId')) return body.teamId;
      else if (body?.team?.id !== undefined) return body.team.id;
    }
  } else if (body.hasOwnProperty('is_enterprise_install')) {
    if (body.is_enterprise_install === 'true' || body.is_enterprise_install === true) {
      if (body.hasOwnProperty('enterprise_id')) return body.enterprise_id;
      else if (body.hasOwnProperty('enterpriseId')) return body.enterpriseId;
      else if (body?.enterprise?.id !== undefined) return body.enterprise.id;
    } else {
      if (body.hasOwnProperty('team_id')) return body.team_id;
      else if (body.hasOwnProperty('teamId')) return body.teamId;
      else if (body?.team?.id !== undefined) return body.team.id;
    }
  } else {
    if (body.hasOwnProperty('enterprise_id')) return body.enterprise_id;
    else if (body.hasOwnProperty('enterpriseId')) return body.enterpriseId;
    else if (body?.enterprise?.id !== undefined) return body.enterprise.id;
    else if (body.hasOwnProperty('team_id')) return body.team_id;
    else if (body.hasOwnProperty('teamId')) return body.teamId;
    else if (body?.team?.id !== undefined) return body.team.id;
  }
  return null;
}

module.exports = { getTeamOrEnterpriseId };
